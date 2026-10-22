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

  inspect(_handle: ExecutionHandle): Promise<ProviderState> {
    return Promise.resolve('absent');
  }

  readWorkspace(_handle: ExecutionHandle): Promise<WorkspaceFile[]> {
    return Promise.reject(this.refuse());
  }

  readDirectory(_handle: ExecutionHandle, _directory: string): Promise<WorkspaceFile[]> {
    return Promise.reject(this.refuse());
  }

  stats(_handle: ExecutionHandle): Promise<WorkloadStats | null> {
    return Promise.resolve(null);
  }

  diskUsage(_handle: ExecutionHandle): Promise<number | null> {
    return Promise.resolve(null);
  }

  publishedPorts(_handle: ExecutionHandle): Promise<PublishedPort[]> {
    return Promise.resolve([]);
  }

  startProcess(_handle: ExecutionHandle, _options: StartProcessOptions): Promise<RunningProcess> {
    return Promise.reject(this.refuse());
  }

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

  stopTerminal(_handle: ExecutionHandle, _terminalId: string): Promise<void> {
    return Promise.resolve();
  }

  terminalRunning(_handle: ExecutionHandle, _terminalId: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  listWorkloads(): Promise<ManagedWorkload[]> {
    return Promise.resolve([]);
  }

  listNetworks(): Promise<ManagedNetwork[]> {
    return Promise.resolve([]);
  }

  removeNetwork(_id: string): Promise<void> {
    return Promise.resolve();
  }

  private refuse(): AppError {
    return new AppError('RUNTIME_UNAVAILABLE', this.reason, { expose: true });
  }
}
