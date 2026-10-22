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

/**
 * One execution provider over several machines.
 *
 * Implements the same port every layer above already uses, so nothing outside
 * this directory learns that there is more than one host. That is the whole
 * point of the port having existed since task 13: the decision to spread across
 * machines turns out to be a provider, not a rewrite.
 *
 * Two jobs, and they are quite different:
 *
 *  - **Placing** a new workload, which is a decision, made by the scheduler
 *    against declared capacity and what the platform has already placed.
 *  - **Finding** an existing one, which is not a decision at all. A workload
 *    lives where it was created, and asking the wrong host about it would
 *    produce "no such container" for something that is running perfectly well.
 *
 * The second is why the identifier a workload comes back with carries its host:
 * `host/id`. Every layer above already treats that value as opaque and stores it
 * in one column, so encoding costs nothing there, where adding a second field
 * would mean threading a host through a dozen call sites that have no business
 * knowing machines exist.
 */

export interface RoutingProviderOptions {
  hosts: readonly ExecutionHostConfig[];
  /** Built once per host, by whoever knows how to build one. */
  providers: ReadonlyMap<string, ExecutionProvider>;
  /** What the platform has already placed, for the scheduler. */
  placement: PlacementSource;
  /**
   * The host an identifier with no host in it belongs to.
   *
   * Every workload created before this existed. Without it, adding a second host
   * would make every running container unreachable, which is the one thing this
   * change must not do.
   */
  defaultHost: string;
}

export class RoutingExecutionProvider implements ExecutionProvider {
  readonly name = 'routing';

  constructor(
    private readonly options: RoutingProviderOptions,
    private readonly log: Logger,
  ) {}

  /**
   * Why nothing can run, or null when something can.
   *
   * **Any** reachable host is enough. A platform with three hosts and one down
   * is a platform that can still start a project, and reporting it unavailable
   * would refuse work it is perfectly able to do.
   *
   * All of them down reports the first host's own reason rather than a summary.
   * The reasons are written to be shown to a person, and three of them
   * concatenated is not.
   */
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

  /**
   * Places a new workload and records where it went.
   *
   * The handle that comes back carries the host in its identifier, and also
   * names it separately so the caller can write it down. The column is what the
   * scheduler counts; the encoding is what routing reads. Both are derived here,
   * at the one moment the decision is made, so they cannot disagree.
   */
  async create(request: ProvisionRequest): Promise<ExecutionHandle> {
    const [loads, drained] = await Promise.all([
      this.options.placement.currentLoad(),
      this.options.placement.drainedHosts?.() ?? Promise.resolve(new Set<string>()),
    ]);
    // A drained host is placed on by nobody, and is otherwise exactly as it was:
    // everything already on it is still routed to it.
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

  // --- Everything else goes to the host the workload is already on ----------

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

  /**
   * What the execution plane observes, with one deliberate substitution.
   *
   * A workload on a host that is no longer configured is reported `absent`
   * rather than raising. It genuinely is absent as far as this platform is
   * concerned: nothing here can reach it, and reconciliation depends on being
   * able to ask about something that may not be there.
   */
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

  /** Null for a host that is gone, as it is for a reading that failed. */
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

  /** Empty for a host that is gone: nothing here can reach anything on it. */
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

  /** False for a host that is gone: nothing here can reach anything on it. */
  async terminalRunning(handle: ExecutionHandle, terminalId: string): Promise<boolean> {
    const routed = this.resolve(handle);
    if (!routed) return false;

    return routed.provider.terminalRunning(routed.local, terminalId);
  }

  /**
   * Everything every host is holding, with each identifier already routable.
   *
   * Encoded here rather than by the hosts, for the same reason `create` encodes:
   * a host provider does not know its own name, and the caller must be able to
   * hand an identifier from this list straight back to `destroy`.
   *
   * **A host that cannot be reached fails the whole listing.** This is the one
   * place in this file where a host being down is not routed around, and it is
   * deliberate: the caller is cleanup, cleanup decides what to delete by
   * comparing this list against the database, and a list that silently omitted a
   * machine's containers would make every workload on it look like an orphan.
   * Refusing to enumerate is recoverable. Deleting a host's worth of running
   * projects is not.
   */
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

  /** The same fan-out, and the same refusal to answer partially. */
  async listNetworks(): Promise<ManagedNetwork[]> {
    const perHost = await Promise.all(
      [...this.options.providers].map(async ([host, provider]) => {
        const networks = await provider.listNetworks();
        return networks.map((network) => ({ ...network, id: encodeWorkloadId(host, network.id) }));
      }),
    );

    return perHost.flat();
  }

  /**
   * Removes one network from the host it is on.
   *
   * A network on a host that is no longer configured is left alone, and that is
   * not a silent failure: nothing here can reach the machine, so there is
   * nothing to do about it, and reporting success would be the lie. It returns
   * because the caller is a sweep that must not stop on one unreachable host.
   */
  async removeNetwork(id: string): Promise<void> {
    const { host, externalId } = decodeWorkloadId(id, this.options.defaultHost);
    const provider = this.options.providers.get(host);

    if (!provider) {
      this.log.warn({ network: id, host }, 'a network sits on a host that is not configured');
      return;
    }

    await provider.removeNetwork(externalId);
  }

  // -------------------------------------------------------------------------

  /** The host a workload is on, and its identifier there. */
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

  /**
   * Runs an operation against the host a workload is on, or refuses.
   *
   * A missing host is a refusal rather than a silent success, for everything
   * except the three questions above that have an honest "nothing there" answer.
   * Pretending to have stopped a container on a machine this platform can no
   * longer reach would be the platform lying about the one thing it is for.
   */
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
      // The scheduler only ever chooses from the list these were built from, so
      // this is a wiring fault rather than a condition to handle.
      throw new Error(`No execution provider was built for host ${host}`);
    }

    return provider;
  }
}
