import type { Logger } from 'pino';
import { AppError } from '../errors/app-error.js';
import { decodeWorkloadId, encodeWorkloadId, type ExecutionHostConfig } from './hosts.js';
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
  TerminalSession,
  WorkloadStats,
  WorkspaceEntry,
  WorkspaceFile,
} from './provider.js';
import { choosePlacement, describeLoad, type PlacementSource } from './scheduler.js';

export interface RoutingProviderOptions {
  hosts: readonly ExecutionHostConfig[];
  providers: ReadonlyMap<string, ExecutionProvider>;
  placement: PlacementSource;
  defaultHost: string;
}

export class RoutingExecutionProvider implements ExecutionProvider {
  readonly name = 'routing';

  constructor(
    private readonly options: RoutingProviderOptions,
    private readonly log: Logger,
  ) {}

  async unavailableReason(): Promise<string | null> {
    const reasons = await Promise.all(
      [...this.options.providers.values()].map((provider) => provider.unavailableReason()),
    );

    if (reasons.some((reason) => reason === null)) return null;

    return (
      reasons.find((reason): reason is string => reason !== null) ??
      'No execution host is configured.'
    );
  }

  async create(request: ProvisionRequest): Promise<ExecutionHandle> {
    const [loads, drained] = await Promise.all([
      this.options.placement.currentLoad(),
      this.options.placement.drainedHosts?.() ?? Promise.resolve(new Set<string>()),
    ]);
    const hosts = this.options.hosts.map((host) =>
      drained.has(host.name) ? { ...host, schedulable: false } : host,
    );
    const placement = choosePlacement(hosts, loads, request.limits);

    const provider = this.providerFor(placement.host.name);

    this.log.info(
      {
        workloadId: request.workloadId,
        host: placement.host.name,
        placed: describeLoad(placement.host, placement.load),
      },
      'workload placed',
    );

    const handle = await provider.create(request);

    return {
      externalId: encodeWorkloadId(placement.host.name, handle.externalId),
      host: placement.host.name,
    };
  }

  seedWorkspace(handle: ExecutionHandle, entries: readonly WorkspaceEntry[]): Promise<void> {
    return this.route(handle, (provider, local) => provider.seedWorkspace(local, entries));
  }

  start(handle: ExecutionHandle): Promise<void> {
    return this.route(handle, (provider, local) => provider.start(local));
  }

  stop(handle: ExecutionHandle, graceSeconds: number): Promise<void> {
    return this.route(handle, (provider, local) => provider.stop(local, graceSeconds));
  }

  destroy(handle: ExecutionHandle): Promise<void> {
    return this.route(handle, (provider, local) => provider.destroy(local));
  }

  async inspect(handle: ExecutionHandle): Promise<ProviderState> {
    const routed = this.resolve(handle);
    if (!routed) return 'absent';

    return routed.provider.inspect(routed.local);
  }

  readWorkspace(handle: ExecutionHandle): Promise<WorkspaceFile[]> {
    return this.route(handle, (provider, local) => provider.readWorkspace(local));
  }

  readDirectory(handle: ExecutionHandle, directory: string): Promise<WorkspaceFile[]> {
    return this.route(handle, (provider, local) => provider.readDirectory(local, directory));
  }

  async stats(handle: ExecutionHandle): Promise<WorkloadStats | null> {
    const routed = this.resolve(handle);
    if (!routed) return null;

    return routed.provider.stats(routed.local);
  }

  async diskUsage(handle: ExecutionHandle): Promise<number | null> {
    const routed = this.resolve(handle);
    if (!routed) return null;
    return routed.provider.diskUsage(routed.local);
  }

  async publishedPorts(handle: ExecutionHandle): Promise<PublishedPort[]> {
    const routed = this.resolve(handle);
    if (!routed) return [];

    return routed.provider.publishedPorts(routed.local);
  }

  startProcess(handle: ExecutionHandle, options: StartProcessOptions): Promise<RunningProcess> {
    return this.route(handle, (provider, local) => provider.startProcess(local, options));
  }

  stopProcess(handle: ExecutionHandle, graceSeconds: number): Promise<void> {
    return this.route(handle, (provider, local) => provider.stopProcess(local, graceSeconds));
  }

  processRunning(handle: ExecutionHandle): Promise<boolean> {
    return this.route(handle, (provider, local) => provider.processRunning(local));
  }

  openTerminal(handle: ExecutionHandle, options: TerminalOptions): Promise<TerminalSession> {
    return this.route(handle, (provider, local) => provider.openTerminal(local, options));
  }

  startTerminal(
    handle: ExecutionHandle,
    terminalId: string,
    options: TerminalOptions,
  ): Promise<void> {
    return this.route(handle, (provider, local) =>
      provider.startTerminal(local, terminalId, options),
    );
  }

  attachTerminal(handle: ExecutionHandle, terminalId: string): Promise<TerminalSession> {
    return this.route(handle, (provider, local) => provider.attachTerminal(local, terminalId));
  }

  stopTerminal(handle: ExecutionHandle, terminalId: string): Promise<void> {
    return this.route(handle, (provider, local) => provider.stopTerminal(local, terminalId));
  }

  async terminalRunning(handle: ExecutionHandle, terminalId: string): Promise<boolean> {
    const routed = this.resolve(handle);
    if (!routed) return false;

    return routed.provider.terminalRunning(routed.local, terminalId);
  }

  async listWorkloads(): Promise<ManagedWorkload[]> {
    const perHost = await Promise.all(
      [...this.options.providers].map(async ([host, provider]) => {
        const workloads = await provider.listWorkloads();
        return workloads.map((workload) => ({
          ...workload,
          externalId: encodeWorkloadId(host, workload.externalId),
        }));
      }),
    );

    return perHost.flat();
  }

  async listNetworks(): Promise<ManagedNetwork[]> {
    const perHost = await Promise.all(
      [...this.options.providers].map(async ([host, provider]) => {
        const networks = await provider.listNetworks();
        return networks.map((network) => ({ ...network, id: encodeWorkloadId(host, network.id) }));
      }),
    );

    return perHost.flat();
  }

  async removeNetwork(id: string): Promise<void> {
    const { host, externalId } = decodeWorkloadId(id, this.options.defaultHost);
    const provider = this.options.providers.get(host);

    if (!provider) {
      this.log.warn({ network: id, host }, 'a network sits on a host that is not configured');
      return;
    }

    await provider.removeNetwork(externalId);
  }

  private resolve(
    handle: ExecutionHandle,
  ): { provider: ExecutionProvider; local: ExecutionHandle } | undefined {
    const { host, externalId } = decodeWorkloadId(handle.externalId, this.options.defaultHost);

    const provider = this.options.providers.get(host);
    if (!provider) {
      this.log.warn({ host }, 'a workload names an execution host this platform no longer has');
      return undefined;
    }

    return { provider, local: { externalId } };
  }

  private route<T>(
    handle: ExecutionHandle,
    work: (provider: ExecutionProvider, local: ExecutionHandle) => Promise<T>,
  ): Promise<T> {
    const routed = this.resolve(handle);

    if (!routed) {
      return Promise.reject(
        new AppError(
          'RUNTIME_UNAVAILABLE',
          'This is running on a machine this installation can no longer reach.',
          { expose: true, context: { externalId: handle.externalId } },
        ),
      );
    }

    return work(routed.provider, routed.local);
  }

  private providerFor(host: string): ExecutionProvider {
    const provider = this.options.providers.get(host);

    if (!provider) {
      throw new Error(`No execution provider was built for host ${host}`);
    }

    return provider;
  }
}
