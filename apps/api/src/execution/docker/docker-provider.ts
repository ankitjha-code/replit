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

/**
 * Runs project workloads as Docker containers.
 *
 * The only place in the control plane allowed to speak to a container runtime,
 * which lint enforces. Everything above it deals in runtime rows.
 *
 * What this provider does not do is as important as what it does. It never
 * mounts anything into a workload, so the daemon socket cannot reach one. It
 * never runs a command on the host: every command it issues goes to the Docker
 * API, and the workloads themselves are the only place user code runs.
 */

export interface DockerProviderOptions extends Omit<
  ContainerSpecOptions,
  'network' | 'publishPorts'
> {
  /**
   * The prefix each project's own network is named from.
   *
   * A network per project rather than one for all of them. A bridge network is a
   * local network: everything on it can reach everything else on it by name, so
   * a single shared one would let any project's code connect to every other
   * project's container. No amount of capability dropping prevents that, because
   * it is not a privilege — it is a route.
   */
  networkPrefix: string;
  /**
   * Whether preview ports are published on the host: `auto`, `always`, `never`.
   *
   * `auto` publishes only on Docker Desktop, where it is the only way the host
   * can reach a container, and never on Linux, where publishing would open every
   * project's application to every other project. See `publishPorts` in the
   * container spec for the finding behind this.
   */
  publishMode?: 'auto' | 'always' | 'never';
  /**
   * The range project networks are carved from, and how big each one is.
   *
   * Without it Docker picks, from a default pool that runs out at about thirty
   * networks — after which no project can start. See `subnets.ts`.
   */
  subnetPool?: SubnetPool;
  /**
   * How much of a durable terminal's log is replayed when somebody attaches.
   *
   * The whole log would be correct and unusable: a session that has been
   * printing for a day would send a browser a day of output before showing a
   * prompt. This is the screen somebody left, not the history of the session.
   */
  terminalReplayBytes: number;

  /**
   * A container to attach to each project network, when one is configured.
   *
   * The database server projects share. Isolating projects from each other takes
   * away the route to it as well, so it is put back deliberately and one project
   * at a time, rather than by leaving every project on one network and hoping.
   */
  sharedServiceContainer?: string | undefined;
  /** Ceilings on reading a workspace back. */
  read: ReadWorkspaceOptions;
  /** Ceilings on collecting a build's output, which keeps what a sync drops. */
  collect: ReadWorkspaceOptions;
  /** How long an image pull may take before it is abandoned. */
  pullTimeoutMs: number;
  /** How long a reachability answer is reused, so a page view is not a ping. */
  availabilityTtlMs: number;
}

/** Docker's "no such thing" status, which several operations treat as success. */
const NOT_FOUND = 404;
/** Returned when a container is already in the state being asked for. */
const NOT_MODIFIED = 304;
const ALREADY_EXISTS = 409;

export class DockerExecutionProvider implements ExecutionProvider {
  readonly name = 'docker';

  private availability: { reason: string | null; at: number } | undefined;
  /** Project networks this process has already prepared, so it does not re-ask. */

  constructor(
    private readonly docker: Docker,
    private readonly options: DockerProviderOptions,
    private readonly log: Logger,
  ) {}

  /**
   * Whether the daemon is reachable.
   *
   * Cached briefly. Every workspace page asks this question, and a ping per
   * page view is a cost with no answer attached: a daemon that died a second
   * ago will be reported on the next request either way.
   */
  async unavailableReason(): Promise<string | null> {
    const cached = this.availability;
    if (cached && Date.now() - cached.at < this.options.availabilityTtlMs) return cached.reason;

    let reason: string | null;
    try {
      await this.docker.ping();
      reason = await this.missingRuntimeReason();
    } catch (error) {
      this.log.warn({ err: error }, 'Docker is not reachable');
      // Names the thing to check without quoting the driver, whose message can
      // carry a socket path and a host name.
      reason = 'The container service is not reachable, so projects cannot be started.';
    }

    this.availability = { reason, at: Date.now() };
    return reason;
  }

  /**
   * Refuses when the configured sandbox runtime is not installed.
   *
   * Without this, choosing gVisor on a host that lacks it would make every
   * project fail to start with the daemon's own error. Said once, plainly, and
   * the whole execution plane reports unavailable until it is fixed.
   */
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

    // A container left behind by a previous attempt holds the name. Removing
    // it is safe: the control plane is the authority on what should exist, and
    // it has just decided this runtime is being created.
    await this.removeIfPresent(spec.name);

    let container: Docker.Container;
    try {
      container = await this.docker.createContainer(spec);
    } catch (error) {
      /*
       * The network went between being ensured and being used.
       *
       * Networks are removed when a project's last workload goes, so another of
       * this project's workloads finishing at this moment removes it from under
       * this one. Ensured again and tried once more, because the second attempt
       * cannot race the same way: the network it ensures is about to be used.
       */
      if (statusOf(error) !== NOT_FOUND || !/network/i.test(messageOf(error))) throw error;
      await this.ensureProjectNetwork(request.projectId);
      container = await this.docker.createContainer(spec);
    }

    await this.prepareForWorkloadUser(container.id);
    return { externalId: container.id };
  }

  /**
   * Copies the project's files in.
   *
   * Done while the container is created but not running, so nothing inside it
   * can observe a half-populated workspace.
   */
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
      // Already running is the state that was asked for.
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
      // Already stopped, or already gone. Both are the requested outcome.
      if (status === NOT_MODIFIED || status === NOT_FOUND) return;
      throw this.failure(error, 'The environment could not be stopped.', {
        containerId: handle.externalId,
      });
    }
  }

  async destroy(handle: ExecutionHandle): Promise<void> {
    // Which project it belonged to, read before it goes: afterwards there is
    // nothing left to ask.
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
      // A container the daemon has never heard of is absent, which is an
      // answer rather than a failure. Reconciliation depends on being able to
      // ask about something that may not exist.
      if (statusOf(error) === NOT_FOUND) return 'absent';
      throw this.failure(error, 'The environment could not be inspected.', {
        containerId: handle.externalId,
      });
    }
  }

  /**
   * Reads the workspace back out of the container.
   *
   * Bounded on every axis, because the archive comes from a directory a person
   * has been running commands in and there is no upper limit on what they put
   * there. A ceiling reached is reported as a refusal rather than as a short
   * answer: the caller uses this to decide what to delete, and a partial list
   * presented as complete would delete files that were simply never read.
   */
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

  /**
   * What the container is using right now.
   *
   * Asked without streaming, which is what makes the processor figure possible
   * at all: Docker reports cumulative counters, and a single reading of a
   * cumulative counter says nothing. The non-streaming call supplies the
   * previous sample alongside the current one so the delta can be taken.
   *
   * Null for every failure. A container that has gone, a daemon that did not
   * answer and a payload that made no sense are all "not measured", which is
   * the honest thing to show; distinguishing them would be detail for a log
   * rather than for a chart.
   */
  /**
   * The container's writable layer, as the daemon measures it.
   *
   * Everything the workload wrote outside its tmpfs: the workspace, the home
   * directory, anything installed. Asking for the size makes the daemon walk
   * the layer, so this is called on a timer, not per request.
   */
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

  /**
   * Reads one directory out, keeping everything in it.
   *
   * The counterpart of `readWorkspace` and its opposite in the one respect that
   * matters: nothing is filtered. A static build puts its output in `dist` or
   * `build`, both of which the workspace exclusion list drops on purpose, so
   * collecting a build through that path would reliably produce nothing.
   */
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

  /**
   * The loopback addresses Docker assigned to the watched ports.
   *
   * Read from the daemon each time rather than remembered, because the
   * assignment changes every time a container is recreated and a stale one
   * points at whatever took the port next.
   */
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
        // Docker reports 0.0.0.0 for a binding it made on every address. The
        // spec asks for loopback, so this is where the platform connects.
        const host = binding.HostIp && binding.HostIp !== '0.0.0.0' ? binding.HostIp : '127.0.0.1';
        published.push({ containerPort, host, port });
      }
    }

    if (published.length > 0) return published;

    /*
     * Nothing published: the container's own address, and its own ports.
     *
     * The ordinary case on Linux, where the platform can dial a container on a
     * bridge network directly. Same shape as a published port, so nothing that
     * connects to one needs to know which kind it was given.
     */
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

  // -------------------------------------------------------------------------

  /**
   * The network runtimes are attached to.
   *
   * Their own, not the platform's. A workload that shared a network with the
   * control plane could reach the database directly, at which point the
   * separation of the two planes would exist only on paper.
   */
  /**
   * A network of this project's own, and the shared service attached to it.
   *
   * One per project, which is the point. Everything on a bridge network can
   * reach everything else on it by container name, so a single shared network
   * would let any project's code connect to every other project's container —
   * not a privilege that could be dropped, but a route that has to be absent.
   *
   * The database server is put back on deliberately, one project at a time. A
   * failure to attach it is logged rather than fatal: a project whose database
   * is unreachable is a project that reports a connection error, and refusing to
   * start it at all would turn one broken dependency into no environment.
   */
  /**
   * Every container this platform made on this host, running or not.
   *
   * `all: true` is the whole point: a container that exited is exactly the kind
   * that gets left behind, and listing only running ones would find none of
   * them. Filtered by the managed label at the daemon rather than here, so a
   * machine that also runs other things never sends them over the socket.
   */
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
        // Docker reports seconds; everything above this line deals in dates.
        createdAt: container.Created ? new Date(container.Created * 1000) : undefined,
      };
    });
  }

  /**
   * Every per-project network this platform made on this host.
   *
   * The attachment count comes from an inspect per network rather than from the
   * listing, which does not carry containers. That is one call per project
   * network on a sweep, which is acceptable for something that runs on a timer
   * and unacceptable to get wrong: removing a network with something on it
   * disconnects a running workload from its database.
   */
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

        /*
         * The shared database server does not count as an attachment.
         *
         * It is put on every project's network deliberately, so counting it
         * would make every network look occupied and nothing would ever be
         * removed. What matters is whether a *workload* is still there.
         */
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
    /*
     * The shared database server is let go of first.
     *
     * It is attached to every project network deliberately, and the daemon
     * refuses to remove a network with anything still connected — so without
     * this, no project network that ever had a database could be removed, by
     * a project deletion or by the cleanup sweep. Found by looking at what a
     * deleted project left behind, not by any test.
     */
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
      // Already gone is the state being asked for. Two sweeps overlapping, or a
      // project deleted between the listing and this call, both land here.
      if (statusOf(error) === NOT_FOUND) return;
      throw this.failure(error, 'An environment network could not be removed.', { network: id });
    }
  }

  /**
   * Who every exec runs as, and where its home is.
   *
   * One place, used by all four of them. A new exec added without it would
   * silently run as root inside a container that is otherwise unprivileged,
   * which is the failure mode this exists to make hard.
   */
  private identity(): { user: string | null; home: string } {
    return {
      user: this.options.hardening.workloadUser,
      home: this.options.hardening.homePath,
    };
  }

  private publishDecision: boolean | undefined;

  /**
   * Whether this daemon needs preview ports published to be reachable at all.
   *
   * Decided once and remembered. `auto` asks the daemon what it is: Docker
   * Desktop runs containers inside a virtual machine whose addresses the host
   * cannot reach, so publishing is the only way in; anything else is a Linux
   * host that can dial a container directly, and publishing there would only
   * add the cross-project exposure. A daemon that cannot be asked is treated as
   * Linux — the safe side of the question.
   */
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

  /** The workload's numeric identity, or undefined when it runs as root. */
  private workloadOwner(): { uid: number; gid: number } | undefined {
    const user = this.options.hardening.workloadUser;
    if (!user) return undefined;

    const [uid, gid] = user.split(':').map(Number);
    if (uid === undefined || gid === undefined || Number.isNaN(uid) || Number.isNaN(gid)) {
      return undefined;
    }

    return { uid, gid };
  }

  /**
   * Makes the directories a non-root workload has to write to belong to it.
   *
   * Two of them:
   *
   *  - **The workspace directory itself.** Its contents arrive owned correctly,
   *    because the archive says so, but the directory is created by the daemon
   *    from `WorkingDir` and is owned by root — so a workload could edit every
   *    file it had and not create a new one.
   *  - **A home directory**, which does not exist in most images at all. Without
   *    a writable one no package manager works, and that is the failure that
   *    makes somebody turn the whole measure off.
   *
   * ## Why an archive, and not a root command
   *
   * The first version ran `chown` as root inside the container, and it could
   * never have worked: every capability is dropped container-wide, so "root" in
   * there has no `CAP_CHOWN` either. Adding the capability back would work and
   * would widen every container the platform makes.
   *
   * The daemon, though, extracts archives with its own privileges and honours
   * the ownership written in them. So the two directories are delivered as
   * empty directory entries that already belong to the workload — no exec, no
   * capability, and nothing in the container ever runs as root. Done at
   * creation, so it holds whether or not there are any files to seed.
   */
  private async prepareForWorkloadUser(containerId: string): Promise<void> {
    const owner = this.workloadOwner();
    if (!owner) return;

    // Relative to `/`, which is where this is extracted. Both paths are the
    // platform's own configuration, never anything a person typed.
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
      // Private: this is where caches and credentials a tool writes end up.
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

    /*
     * Asked every time rather than remembered.
     *
     * Networks now come and go — one is removed when its project's last
     * workload is — so a cache of "this exists" would be wrong exactly when it
     * mattered, and in a different process from the one that removed it. One
     * inspect per workload created is a small price for never attaching a
     * container to a network that is not there.
     */
    const existing = await this.docker
      .getNetwork(name)
      .inspect()
      .catch(() => undefined);

    if (!existing) await this.createProjectNetwork(name, projectId);

    await this.attachSharedService(name);
    return name;
  }

  /**
   * Creates a project network, in a small subnet of the platform's own choosing.
   *
   * Tries the subnet the project's identifier points at, then walks forward
   * past any in use. Two creates racing can pick the same free subnet; the
   * daemon refuses the second as overlapping, and it moves on to the next.
   */
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
        // Someone else created it first, which is the state being asked for.
        if (statusOf(error) === ALREADY_EXISTS) return;

        // Taken between listing and creating. Mark it and try the next one.
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

  /** Every subnet the platform's own networks are using. */
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

  /**
   * Removes a project's network once nothing of the project is on it.
   *
   * Called after a workload is removed. Without it every project that had ever
   * started kept a network for ever, which — before subnets were small — is
   * what exhausted the daemon's address pool, and is still address space held
   * for projects nobody is running.
   *
   * The shared database server does not count as something on it: it is
   * attached to every project network deliberately. Anything else still
   * attached means another of the project's workloads is running, and the
   * network stays.
   */
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
      // Not fatal: an idle network costs address space, not correctness, and
      // the cleanup sweep removes it once its project is gone.
      this.log.warn({ err: error, network: name }, 'an idle project network could not be removed');
    });
  }

  /** Puts the shared database server on a project's network, if there is one. */
  private async attachSharedService(network: string): Promise<void> {
    const container = this.options.sharedServiceContainer;
    if (!container) return;

    try {
      await this.docker.getNetwork(network).connect({ Container: container });
    } catch (error) {
      const status = statusOf(error);

      // Already on it, which is the state being asked for, or the container is
      // not there — an installation with no project database server.
      if (status === ALREADY_EXISTS || status === NOT_FOUND) return;
      // Docker answers a second attach with 403 and "already exists" rather than
      // 409. Two processes starting two workloads for one project at once — an
      // environment and a deployment — both attach, and the second finds the
      // first's work done.
      if (/already exists/i.test(messageOf(error))) return;

      this.log.warn(
        { err: error, network, container },
        'the shared database server could not be attached to a project network',
      );
    }
  }

  /**
   * Makes sure the image is on the host, pulling it if not.
   *
   * Bounded, because a pull over a slow link would otherwise hold the request
   * open indefinitely and the person waiting would be told nothing.
   */
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

  /**
   * Turns a daemon error into one the caller may see.
   *
   * The message is written here; the driver's own text goes to `context`,
   * which is logged and never serialised, because it can carry socket paths
   * and image registry addresses.
   */
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

/** Builds a client from configuration, defaulting to the platform's own socket. */
export function createDockerClient(socketPath?: string): Docker {
  // With nothing configured, dockerode uses DOCKER_HOST or the platform's
  // default socket, which is what a normal local install wants.
  return socketPath ? new Docker({ socketPath }) : new Docker();
}

/**
 * What a listing's one-word state means, in the port's vocabulary.
 *
 * A listing reports a string where an inspect reports a structure, so this
 * cannot reuse `providerState`. The unknown case is `exited` rather than
 * `running` on purpose: cleanup acts on things that are not running, and a
 * state this does not recognise is one nobody should be deleting on.
 */
function listedState(state: string | undefined): ProviderState {
  if (state === 'running') return 'running';
  if (state === 'created') return 'created';
  return 'exited';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
