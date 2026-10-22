import { AppError } from '../errors/app-error.js';
import type {
  ExecutionHandle,
  ManagedNetwork,
  ManagedWorkload,
  ExecutionProvider,
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
} from './provider.js';

/**
 * The provider used when the platform has no execution backend.
 *
 * This is not a stub that pretends to work. It is the honest answer to "can
 * this installation run code", and the answer is no. Every operation refuses
 * with a reason a person can act on, and nothing is recorded as running.
 *
 * The alternative, a provider that returns success and invents a container id,
 * would make the workspace show a running project that does not exist. Every
 * surface downstream would then be lying: the status, the console, the
 * preview, the metrics.
 */
export class UnavailableExecutionProvider implements ExecutionProvider {
  readonly name = 'none';

  constructor(
    private readonly reason = 'This installation has no execution backend configured, so projects cannot be started.',
  ) {}

  unavailableReason(): Promise<string | null> {
    return Promise.resolve(this.reason);
  }

  create(_request: ProvisionRequest): Promise<ExecutionHandle> {
    return Promise.reject(this.refuse());
  }

  seedWorkspace(_handle: ExecutionHandle, _entries: readonly WorkspaceEntry[]): Promise<void> {
    return Promise.reject(this.refuse());
  }

  start(_handle: ExecutionHandle): Promise<void> {
    return Promise.reject(this.refuse());
  }

  stop(_handle: ExecutionHandle, _graceSeconds: number): Promise<void> {
    return Promise.reject(this.refuse());
  }

  destroy(_handle: ExecutionHandle): Promise<void> {
    return Promise.reject(this.refuse());
  }

  /**
   * Nothing exists, which is true rather than an error.
   *
   * Reconciliation asks this question about runtimes left behind by a previous
   * configuration, and "absent" is the accurate answer: whatever was once
   * running, this provider does not have it.
   */
  inspect(_handle: ExecutionHandle): Promise<ProviderState> {
    return Promise.resolve('absent');
  }

  readWorkspace(_handle: ExecutionHandle): Promise<WorkspaceFile[]> {
    return Promise.reject(this.refuse());
  }

  readDirectory(_handle: ExecutionHandle, _directory: string): Promise<WorkspaceFile[]> {
    return Promise.reject(this.refuse());
  }

  /** Nothing exists, so nothing was measured. Null rather than a refusal. */
  stats(_handle: ExecutionHandle): Promise<WorkloadStats | null> {
    return Promise.resolve(null);
  }

  diskUsage(_handle: ExecutionHandle): Promise<number | null> {
    return Promise.resolve(null);
  }

  /** Nothing exists, so nothing is published. True rather than an error. */
  publishedPorts(_handle: ExecutionHandle): Promise<PublishedPort[]> {
    return Promise.resolve([]);
  }

  startProcess(_handle: ExecutionHandle, _options: StartProcessOptions): Promise<RunningProcess> {
    return Promise.reject(this.refuse());
  }

  /** Nothing runs, so stopping is already done. */
  stopProcess(_handle: ExecutionHandle, _graceSeconds: number): Promise<void> {
    return Promise.resolve();
  }

  processRunning(_handle: ExecutionHandle): Promise<boolean> {
    return Promise.resolve(false);
  }

  openTerminal(_handle: ExecutionHandle, _options: TerminalOptions): Promise<TerminalSession> {
    return Promise.reject(this.refuse());
  }

  startTerminal(
    _handle: ExecutionHandle,
    _terminalId: string,
    _options: TerminalOptions,
  ): Promise<void> {
    return Promise.reject(this.refuse());
  }

  attachTerminal(_handle: ExecutionHandle, _terminalId: string): Promise<TerminalSession> {
    return Promise.reject(this.refuse());
  }

  /** Nothing runs, so stopping has already happened. */
  stopTerminal(_handle: ExecutionHandle, _terminalId: string): Promise<void> {
    return Promise.resolve();
  }

  terminalRunning(_handle: ExecutionHandle, _terminalId: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * Nothing was created, so nothing can be left behind.
   *
   * An empty list rather than a refusal, and the distinction matters to the
   * caller: cleanup that could not enumerate must do nothing, while cleanup that
   * enumerated nothing is finished. A refusal here would make an installation
   * with no execution backend log a failure on every sweep for ever.
   */
  listWorkloads(): Promise<ManagedWorkload[]> {
    return Promise.resolve([]);
  }

  listNetworks(): Promise<ManagedNetwork[]> {
    return Promise.resolve([]);
  }

  /** Nothing exists to remove, so removal has already happened. */
  removeNetwork(_id: string): Promise<void> {
    return Promise.resolve();
  }

  private refuse(): AppError {
    // Exposed on purpose. The message names a configuration problem, carries
    // no internal detail, and is useless to someone without it.
    return new AppError('RUNTIME_UNAVAILABLE', this.reason, { expose: true });
  }
}
