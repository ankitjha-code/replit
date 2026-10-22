import type { Readable } from 'node:stream';
import Docker from 'dockerode';
import { pack } from 'tar-stream';
import { firstFree, startingIndex, type SubnetPool } from './subnets.js';
import { PREVIEW_CANDIDATE_PORTS } from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type {
  ExecutionHandle,
  ExecutionProvider,
  ManagedNetwork,
  ManagedWorkload,
  ProviderState,
  ProvisionRequest,
  PublishedPort,
  RunningProcess,
  StartProcessOptions,
  TerminalOptions,
  WorkspaceFile,
  TerminalSession,
  WorkloadStats,
  WorkspaceEntry,
} from '../provider.js';
import {
  LABEL_DEPLOYMENT,
  LABEL_KIND,
  LABEL_MANAGED,
  LABEL_PROJECT,
  LABEL_RUNTIME,
  containerCreateOptions,
  providerState,
  workloadStats,
  type ContainerSpecOptions,
  type DockerStats,
} from './container-spec.js';
import { dockerProcessRunning, startDockerProcess, stopDockerProcess } from './docker-process.js';
import {
  attachDetachedTerminal,
  detachedTerminalRunning,
  startDetachedTerminal,
  stopDetachedTerminal,
} from './docker-detached-terminal.js';
import { openDockerTerminal } from './docker-terminal.js';
import { archiveRoot, containerPath, readWorkspaceArchive } from './workspace-reader.js';
import { workspaceArchive } from './workspace-archive.js';
import type { ReadWorkspaceOptions } from './workspace-reader.js';

export interface DockerProviderOptions extends Omit<
  ContainerSpecOptions,
  'network' | 'publishPorts'
> {
  networkPrefix: string;
  publishMode?: 'auto' | 'always' | 'never';
  subnetPool?: SubnetPool;
  terminalReplayBytes: number;

  sharedServiceContainer?: string | undefined;
  read: ReadWorkspaceOptions;
  collect: ReadWorkspaceOptions;
  pullTimeoutMs: number;
  availabilityTtlMs: number;
}

const NOT_FOUND = 404;
const NOT_MODIFIED = 304;
const ALREADY_EXISTS = 409;

export class DockerExecutionProvider implements ExecutionProvider {
  readonly name = 'docker';

  private availability: { reason: string | null; at: number } | undefined;

  constructor(
    private readonly docker: Docker,
    private readonly options: DockerProviderOptions,
    private readonly log: Logger,
  ) {}

  async unavailableReason(): Promise<string | null> {
    const cached = this.availability;
    if (cached && Date.now() - cached.at < this.options.availabilityTtlMs) return cached.reason;

    let reason: string | null;
    try {
      await this.docker.ping();
      reason = await this.missingRuntimeReason();
    } catch (error) {
      this.log.warn({ err: error }, 'Docker is not reachable');
      reason = 'The container service is not reachable, so projects cannot be started.';
    }

    this.availability = { reason, at: Date.now() };
    return reason;
  }

  private async missingRuntimeReason(): Promise<string | null> {
    const wanted = this.options.hardening.ociRuntime;
    if (!wanted) return null;
    const info = (await this.docker.info()) as { Runtimes?: Record<string, unknown> };
    if (info.Runtimes && wanted in info.Runtimes) return null;
    this.log.error({ runtime: wanted }, 'the configured container runtime is not registered');
    return `The container runtime "${wanted}" is not installed on this host, so projects cannot be started.`;
  }

  async create(request: ProvisionRequest): Promise<ExecutionHandle> {
    const network = await this.ensureProjectNetwork(request.projectId);
    await this.ensureImage(request.image);

    const spec = containerCreateOptions(request, {
      ...this.options,
      network,
      publishPorts: await this.shouldPublishPorts(),
    });

    await this.removeIfPresent(spec.name);

    let container: Docker.Container;
    try {
      container = await this.docker.createContainer(spec);
    } catch (error) {
      if (statusOf(error) !== NOT_FOUND || !/network/i.test(messageOf(error))) throw error;
      await this.ensureProjectNetwork(request.projectId);
      container = await this.docker.createContainer(spec);
    }

    await this.prepareForWorkloadUser(container.id);
    return { externalId: container.id };
  }

  async seedWorkspace(handle: ExecutionHandle, entries: readonly WorkspaceEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const archive = workspaceArchive(entries, this.workloadOwner());
    try {
      await this.docker
        .getContainer(handle.externalId)
        .putArchive(archive, { path: this.options.workspacePath });
    } catch (error) {
      throw this.failure(error, 'The project files could not be copied into the environment.', {
        containerId: handle.externalId,
      });
    }
  }

  async start(handle: ExecutionHandle): Promise<void> {
    try {
      await this.docker.getContainer(handle.externalId).start();
    } catch (error) {
      if (statusOf(error) === NOT_MODIFIED) return;
      throw this.failure(error, 'The environment could not be started.', {
        containerId: handle.externalId,
      });
    }
  }

  async stop(handle: ExecutionHandle, graceSeconds: number): Promise<void> {
    try {
      await this.docker.getContainer(handle.externalId).stop({ t: graceSeconds });
    } catch (error) {
      const status = statusOf(error);
      if (status === NOT_MODIFIED || status === NOT_FOUND) return;
      throw this.failure(error, 'The environment could not be stopped.', {
        containerId: handle.externalId,
      });
    }
  }

  async destroy(handle: ExecutionHandle): Promise<void> {
    const projectId = await this.docker
      .getContainer(handle.externalId)
      .inspect()
      .then((info) => info.Config?.Labels?.[LABEL_PROJECT])
      .catch(() => undefined);

    try {
      await this.docker.getContainer(handle.externalId).remove({ force: true, v: true });
    } catch (error) {
      if (statusOf(error) !== NOT_FOUND) {
        throw this.failure(error, 'The environment could not be removed.', {
          containerId: handle.externalId,
        });
      }
    }

    if (projectId) await this.releaseProjectNetworkIfIdle(projectId);
  }

  async inspect(handle: ExecutionHandle): Promise<ProviderState> {
    try {
      return providerState(await this.docker.getContainer(handle.externalId).inspect());
    } catch (error) {
      if (statusOf(error) === NOT_FOUND) return 'absent';
      throw this.failure(error, 'The environment could not be inspected.', {
        containerId: handle.externalId,
      });
    }
  }

  async readWorkspace(handle: ExecutionHandle): Promise<WorkspaceFile[]> {
    const root = archiveRoot(this.options.workspacePath);

    let archive;
    try {
      archive = (await this.docker
        .getContainer(handle.externalId)
        .getArchive({ path: this.options.workspacePath })) as unknown as Readable;
    } catch (error) {
      throw this.failure(error, 'The project files could not be read from the environment.', {
        containerId: handle.externalId,
      });
    }

    const outcome = await readWorkspaceArchive(archive, root, this.options.read);

    if (outcome.truncated) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        'There is more in this environment than the platform will read back. Remove what does not belong in the project, then try again.',
        { expose: true, context: { containerId: handle.externalId } },
      );
    }

    if (outcome.oversized.length > 0) {
      this.log.warn(
        { containerId: handle.externalId, count: outcome.oversized.length },
        'files too large to read back were left in the container',
      );
    }

    return outcome.files;
  }

  async diskUsage(handle: ExecutionHandle): Promise<number | null> {
    try {
      const detail = (await this.docker
        .getContainer(handle.externalId)
        .inspect({ size: true } as never)) as unknown as { SizeRw?: number };
      return typeof detail.SizeRw === 'number' ? detail.SizeRw : null;
    } catch (error) {
      if (statusOf(error) !== NOT_FOUND) {
        this.log.debug(
          { err: error, containerId: handle.externalId },
          'disk usage could not be read',
        );
      }
      return null;
    }
  }

  async stats(handle: ExecutionHandle): Promise<WorkloadStats | null> {
    try {
      const raw = (await this.docker
        .getContainer(handle.externalId)
        .stats({ stream: false })) as unknown as DockerStats;

      return { ...workloadStats(raw), at: new Date() };
    } catch (error) {
      if (statusOf(error) !== NOT_FOUND) {
        this.log.debug(
          { err: error, containerId: handle.externalId },
          'workload statistics could not be read',
        );
      }
      return null;
    }
  }

  async readDirectory(handle: ExecutionHandle, directory: string): Promise<WorkspaceFile[]> {
    const path = containerPath(this.options.workspacePath, directory);
    const root = archiveRoot(path);

    let archive;
    try {
      archive = (await this.docker
        .getContainer(handle.externalId)
        .getArchive({ path })) as unknown as Readable;
    } catch (error) {
      if (statusOf(error) === NOT_FOUND) {
        throw new AppError('BAD_REQUEST', `The build did not produce a "${directory}" directory.`, {
          expose: true,
          context: { containerId: handle.externalId, directory },
        });
      }
      throw this.failure(error, 'The build output could not be read.', {
        containerId: handle.externalId,
      });
    }

    const outcome = await readWorkspaceArchive(archive, root, this.options.collect);

    if (outcome.truncated) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        'This build produced more than the platform will store. Deploy a smaller output directory.',
        { expose: true, context: { containerId: handle.externalId, directory } },
      );
    }

    if (outcome.oversized.length > 0) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        'This build produced a file larger than the platform will store.',
        { expose: true, context: { containerId: handle.externalId, directory } },
      );
    }

    return outcome.files;
  }

  async publishedPorts(handle: ExecutionHandle): Promise<PublishedPort[]> {
    let inspected;
    try {
      inspected = await this.docker.getContainer(handle.externalId).inspect();
    } catch (error) {
      if (statusOf(error) === NOT_FOUND) return [];
      throw this.failure(error, 'The environment could not be inspected.', {
        containerId: handle.externalId,
      });
    }

    const published: PublishedPort[] = [];

    for (const [spec, bindings] of Object.entries(inspected.NetworkSettings.Ports ?? {})) {
      const containerPort = Number.parseInt(spec.split('/')[0] ?? '', 10);
      if (!Number.isInteger(containerPort)) continue;

      for (const binding of bindings ?? []) {
        const port = Number.parseInt(binding.HostPort ?? '', 10);
        if (!Number.isInteger(port) || port === 0) continue;
        const host = binding.HostIp && binding.HostIp !== '0.0.0.0' ? binding.HostIp : '127.0.0.1';
        published.push({ containerPort, host, port });
      }
    }

    if (published.length > 0) return published;

    const address = Object.values(inspected.NetworkSettings.Networks ?? {}).find(
      (network) => network.IPAddress,
    )?.IPAddress;
    if (!address) return [];

    return PREVIEW_CANDIDATE_PORTS.map((port) => ({ containerPort: port, host: address, port }));
  }

  startProcess(handle: ExecutionHandle, options: StartProcessOptions): Promise<RunningProcess> {
    return startDockerProcess(this.docker, handle, options, this.identity());
  }

  stopProcess(handle: ExecutionHandle, graceSeconds: number): Promise<void> {
    return stopDockerProcess(this.docker, handle, graceSeconds, this.identity());
  }

  processRunning(handle: ExecutionHandle): Promise<boolean> {
    return dockerProcessRunning(this.docker, handle, this.identity());
  }

  openTerminal(handle: ExecutionHandle, options: TerminalOptions): Promise<TerminalSession> {
    return openDockerTerminal(this.docker, handle, options, this.identity());
  }

  startTerminal(
    handle: ExecutionHandle,
    terminalId: string,
    options: TerminalOptions,
  ): Promise<void> {
    return startDetachedTerminal(this.docker, handle, terminalId, {
      ...options,
      ...this.identity(),
    });
  }

  attachTerminal(handle: ExecutionHandle, terminalId: string): Promise<TerminalSession> {
    return attachDetachedTerminal(this.docker, handle, terminalId, {
      ...this.identity(),
      replayBytes: this.options.terminalReplayBytes,
    });
  }

  stopTerminal(handle: ExecutionHandle, terminalId: string): Promise<void> {
    return stopDetachedTerminal(this.docker, handle, terminalId, this.identity().user);
  }

  terminalRunning(handle: ExecutionHandle, terminalId: string): Promise<boolean> {
    return detachedTerminalRunning(this.docker, handle, terminalId, this.identity().user);
  }

  async listWorkloads(): Promise<ManagedWorkload[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_MANAGED}=true`] },
    });

    return containers.map((container) => {
      const labels = container.Labels ?? {};
      const kind = labels[LABEL_KIND];

      return {
        externalId: container.Id,
        kind: kind === 'runtime' || kind === 'deployment' ? kind : 'unknown',
        workloadId: labels[LABEL_RUNTIME] ?? labels[LABEL_DEPLOYMENT],
        projectId: labels[LABEL_PROJECT],
        state: listedState(container.State),
        createdAt: container.Created ? new Date(container.Created * 1000) : undefined,
      };
    });
  }

  async listNetworks(): Promise<ManagedNetwork[]> {
    const networks = await this.docker.listNetworks({
      filters: { label: [`${LABEL_MANAGED}=true`] },
    });

    return Promise.all(
      networks.map(async (network) => {
        const detail = await this.docker
          .getNetwork(network.Id)
          .inspect()
          .catch(() => undefined);

        const containers = Object.entries(
          (detail?.Containers ?? {}) as Record<string, { Name?: string }>,
        ).filter(([, member]) => member.Name !== this.options.sharedServiceContainer);

        return {
          id: network.Id,
          name: network.Name,
          projectId: (network.Labels ?? {})[LABEL_PROJECT],
          attached: containers.length,
          createdAt: network.Created ? new Date(network.Created) : undefined,
        };
      }),
    );
  }

  async removeNetwork(id: string): Promise<void> {
    const shared = this.options.sharedServiceContainer;
    if (shared) {
      await this.docker
        .getNetwork(id)
        .disconnect({ Container: shared, Force: true })
        .catch(() => undefined);
    }

    try {
      await this.docker.getNetwork(id).remove();
    } catch (error) {
      if (statusOf(error) === NOT_FOUND) return;
      throw this.failure(error, 'An environment network could not be removed.', { network: id });
    }
  }

  private identity(): { user: string | null; home: string } {
    return {
      user: this.options.hardening.workloadUser,
      home: this.options.hardening.homePath,
    };
  }

  private publishDecision: boolean | undefined;

  private async shouldPublishPorts(): Promise<boolean> {
    if (this.publishDecision !== undefined) return this.publishDecision;

    const mode = this.options.publishMode ?? 'auto';

    if (mode === 'always' || mode === 'never') {
      this.publishDecision = mode === 'always';
    } else {
      const info = (await this.docker.info().catch(() => undefined)) as
        { OperatingSystem?: string } | undefined;
      this.publishDecision = /docker desktop/i.test(info?.OperatingSystem ?? '');
    }

    if (this.publishDecision) {
      this.log.warn(
        'preview ports are published on the host; on this daemon that makes them reachable from other projects',
      );
    }

    return this.publishDecision;
  }

  private workloadOwner(): { uid: number; gid: number } | undefined {
    const user = this.options.hardening.workloadUser;
    if (!user) return undefined;

    const [uid, gid] = user.split(':').map(Number);
    if (uid === undefined || gid === undefined || Number.isNaN(uid) || Number.isNaN(gid)) {
      return undefined;
    }

    return { uid, gid };
  }

  private async prepareForWorkloadUser(containerId: string): Promise<void> {
    const owner = this.workloadOwner();
    if (!owner) return;

    const relative = (path: string): string => `${path.replace(/^\/+|\/+$/g, '')}/`;

    const archive = pack();
    archive.entry({
      name: relative(this.options.workspacePath),
      type: 'directory',
      mode: 0o755,
      uid: owner.uid,
      gid: owner.gid,
    });
    archive.entry({
      name: relative(this.options.hardening.homePath),
      type: 'directory',
      mode: 0o700,
      uid: owner.uid,
      gid: owner.gid,
    });
    archive.finalize();

    try {
      await this.docker
        .getContainer(containerId)
        .putArchive(archive as unknown as Readable, { path: '/' });
    } catch (error) {
      throw this.failure(error, 'The environment could not be prepared for an unprivileged user.', {
        containerId,
      });
    }
  }

  private async ensureProjectNetwork(projectId: string): Promise<string> {
    const name = `${this.options.networkPrefix}-${projectId}`;

    const existing = await this.docker
      .getNetwork(name)
      .inspect()
      .catch(() => undefined);

    if (!existing) await this.createProjectNetwork(name, projectId);

    await this.attachSharedService(name);
    return name;
  }

  private async createProjectNetwork(name: string, projectId: string): Promise<void> {
    const pool = this.options.subnetPool;
    const taken = pool ? await this.subnetsInUse() : new Set<string>();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const subnet = pool ? firstFree(pool, startingIndex(pool, projectId), taken) : undefined;

      if (pool && !subnet) {
        throw new AppError(
          'EXECUTION_FAILED',
          'This installation has run out of network address space for projects.',
          { expose: true, context: { pool: pool.base, prefixLength: pool.prefixLength } },
        );
      }

      try {
        await this.docker.createNetwork({
          Name: name,
          Driver: 'bridge',
          Labels: { [LABEL_MANAGED]: 'true', [LABEL_PROJECT]: projectId },
          ...(subnet ? { IPAM: { Driver: 'default', Config: [{ Subnet: subnet }] } } : {}),
        });
        return;
      } catch (error) {
        if (statusOf(error) === ALREADY_EXISTS) return;

        if (subnet && /overlap/i.test(messageOf(error))) {
          taken.add(subnet);
          continue;
        }

        throw this.failure(error, 'The environment network could not be prepared.', {
          network: name,
          subnet,
        });
      }
    }

    throw new AppError('EXECUTION_FAILED', 'The environment network could not be prepared.', {
      expose: true,
      context: { network: name, problem: 'no free subnet after several attempts' },
    });
  }

  private async subnetsInUse(): Promise<Set<string>> {
    const networks = await this.docker.listNetworks({
      filters: { label: [`${LABEL_MANAGED}=true`] },
    });

    const subnets = new Set<string>();
    for (const network of networks) {
      for (const config of network.IPAM?.Config ?? []) {
        if (config.Subnet) subnets.add(config.Subnet);
      }
    }
    return subnets;
  }

  private async releaseProjectNetworkIfIdle(projectId: string): Promise<void> {
    const name = `${this.options.networkPrefix}-${projectId}`;

    const detail = (await this.docker
      .getNetwork(name)
      .inspect()
      .catch(() => undefined)) as
      { Id?: string; Containers?: Record<string, { Name?: string }> } | undefined;

    if (!detail?.Id) return;

    const members = Object.values(detail.Containers ?? {}).filter(
      (member) => member.Name !== this.options.sharedServiceContainer,
    );
    if (members.length > 0) return;

    await this.removeNetwork(detail.Id).catch((error: unknown) => {
      this.log.warn({ err: error, network: name }, 'an idle project network could not be removed');
    });
  }

  private async attachSharedService(network: string): Promise<void> {
    const container = this.options.sharedServiceContainer;
    if (!container) return;

    try {
      await this.docker.getNetwork(network).connect({ Container: container });
    } catch (error) {
      const status = statusOf(error);

      if (status === ALREADY_EXISTS || status === NOT_FOUND) return;
      if (/already exists/i.test(messageOf(error))) return;

      this.log.warn(
        { err: error, network, container },
        'the shared database server could not be attached to a project network',
      );
    }
  }

  private async ensureImage(image: string): Promise<void> {
    const present = await this.docker.listImages({ filters: { reference: [image] } });
    if (present.length > 0) return;

    this.log.info({ image }, 'Pulling runtime image');

    try {
      await withTimeout(this.pull(image), this.options.pullTimeoutMs);
    } catch (error) {
      throw this.failure(error, `The runtime image ${image} could not be downloaded.`, { image });
    }
  }

  private async pull(image: string): Promise<void> {
    const stream = await this.docker.pull(image);

    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (error: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private async removeIfPresent(name: string | undefined): Promise<void> {
    if (!name) return;
    try {
      await this.docker.getContainer(name).remove({ force: true, v: true });
    } catch (error) {
      if (statusOf(error) === NOT_FOUND) return;
      throw this.failure(error, 'A previous environment could not be cleared away.', { name });
    }
  }

  private failure(error: unknown, message: string, context: Record<string, unknown>): AppError {
    return new AppError('EXECUTION_FAILED', message, {
      expose: true,
      cause: error,
      context: { ...context, provider: this.name },
    });
  }
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? status : undefined;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createDockerClient(socketPath?: string): Docker {
  return socketPath ? new Docker({ socketPath }) : new Docker();
}

function listedState(state: string | undefined): ProviderState {
  if (state === 'running') return 'running';
  if (state === 'created') return 'created';
  return 'exited';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
