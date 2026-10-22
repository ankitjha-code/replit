import type { TerminalSize } from '@platform/shared';
import type {
  ExecutionHandle,
  ExecutionProvider,
  ManagedNetwork,
  ManagedWorkload,
  ProviderState,
  ProvisionRequest,
  ProcessOutput,
  PublishedPort,
  RunningProcess,
  StartProcessOptions,
  TerminalOptions,
  WorkspaceFile,
  TerminalSession,
  WorkloadStats,
  WorkspaceEntry,
} from '../../src/execution/provider.js';

export class RecordingExecutionProvider implements ExecutionProvider {
  readonly name = 'recording';

  readonly created: ProvisionRequest[] = [];
  readonly started: string[] = [];
  readonly stopped: { externalId: string; graceSeconds: number }[] = [];
  readonly seeded: { externalId: string; entries: readonly WorkspaceEntry[] }[] = [];
  readonly destroyed: string[] = [];

  reason: string | null = null;

  readonly terminals: RecordingTerminal[] = [];

  failOn: 'create' | 'seed' | 'start' | 'stop' | 'terminal' | 'read' | 'run' | undefined;
  failure: Error = new Error('provider exploded');

  private state: ProviderState = 'absent';
  private sequence = 0;

  unavailableReason(): Promise<string | null> {
    return Promise.resolve(this.reason);
  }

  create(request: ProvisionRequest): Promise<ExecutionHandle> {
    if (this.failOn === 'create') return Promise.reject(this.failure);
    this.created.push(request);
    this.state = 'created';
    this.sequence += 1;
    return Promise.resolve({ externalId: `workload-${this.sequence}` });
  }

  seedWorkspace(handle: ExecutionHandle, entries: readonly WorkspaceEntry[]): Promise<void> {
    if (this.failOn === 'seed') return Promise.reject(this.failure);
    this.seeded.push({ externalId: handle.externalId, entries });
    return Promise.resolve();
  }

  start(handle: ExecutionHandle): Promise<void> {
    if (this.failOn === 'start') return Promise.reject(this.failure);
    this.started.push(handle.externalId);
    this.state = 'running';
    return Promise.resolve();
  }

  stop(handle: ExecutionHandle, graceSeconds: number): Promise<void> {
    if (this.failOn === 'stop') return Promise.reject(this.failure);
    this.stopped.push({ externalId: handle.externalId, graceSeconds });
    this.state = 'exited';
    return Promise.resolve();
  }

  destroy(handle: ExecutionHandle): Promise<void> {
    this.destroyed.push(handle.externalId);
    this.state = 'absent';
    return Promise.resolve();
  }

  inspect(_handle: ExecutionHandle): Promise<ProviderState> {
    return Promise.resolve(this.state);
  }

  workspace: WorkspaceFile[] = [];

  readWorkspace(_handle: ExecutionHandle): Promise<WorkspaceFile[]> {
    if (this.failOn === 'read') return Promise.reject(this.failure);
    return Promise.resolve(this.workspace);
  }

  usage: WorkloadStats | null = null;

  stats(_handle: ExecutionHandle): Promise<WorkloadStats | null> {
    return Promise.resolve(this.usage);
  }

  disk = new Map<string, number>();

  diskUsage(handle: ExecutionHandle): Promise<number | null> {
    return Promise.resolve(this.disk.get(handle.externalId) ?? null);
  }

  readDirectory(_handle: ExecutionHandle, directory: string): Promise<WorkspaceFile[]> {
    if (this.failOn === 'read') return Promise.reject(this.failure);

    const prefix = directory === '.' || directory === '' ? '' : `${directory}/`;

    return Promise.resolve(
      this.workspace
        .filter((file) => file.path.startsWith(prefix))
        .map((file) => ({ path: file.path.slice(prefix.length), content: file.content })),
    );
  }

  published: PublishedPort[] = [];

  publishedPorts(_handle: ExecutionHandle): Promise<PublishedPort[]> {
    return Promise.resolve(this.published);
  }

  process: RecordingProcess | undefined;
  readonly startedCommands: string[] = [];

  startProcess(_handle: ExecutionHandle, options: StartProcessOptions): Promise<RunningProcess> {
    if (this.failOn === 'run') return Promise.reject(this.failure);
    this.startedCommands.push(options.command);
    this.process = new RecordingProcess(options);
    return Promise.resolve(this.process);
  }

  stopProcess(_handle: ExecutionHandle, _graceSeconds: number): Promise<void> {
    this.process?.end(143);
    this.process = undefined;
    return Promise.resolve();
  }

  processRunning(_handle: ExecutionHandle): Promise<boolean> {
    return Promise.resolve(this.process !== undefined && !this.process.ended);
  }

  openTerminal(handle: ExecutionHandle, options: TerminalOptions): Promise<TerminalSession> {
    if (this.failOn === 'terminal') return Promise.reject(this.failure);
    const terminal = new RecordingTerminal(handle.externalId, options);
    this.terminals.push(terminal);
    return Promise.resolve(terminal);
  }

  readonly detached = new Map<string, RecordingTerminal>();

  startTerminal(
    handle: ExecutionHandle,
    terminalId: string,
    options: TerminalOptions,
  ): Promise<void> {
    if (this.failOn === 'terminal') return Promise.reject(this.failure);
    this.detached.set(terminalId, new RecordingTerminal(handle.externalId, options));
    return Promise.resolve();
  }

  attachTerminal(_handle: ExecutionHandle, terminalId: string): Promise<TerminalSession> {
    const terminal = this.detached.get(terminalId);
    if (!terminal) return Promise.reject(this.failure);

    this.terminals.push(terminal);
    return Promise.resolve(terminal);
  }

  stopTerminal(_handle: ExecutionHandle, terminalId: string): Promise<void> {
    this.detached.delete(terminalId);
    return Promise.resolve();
  }

  terminalRunning(_handle: ExecutionHandle, terminalId: string): Promise<boolean> {
    const terminal = this.detached.get(terminalId);
    return Promise.resolve(terminal !== undefined && !terminal.ended);
  }

  workloads: ManagedWorkload[] = [];
  networks: ManagedNetwork[] = [];
  readonly removedNetworks: string[] = [];

  listWorkloads(): Promise<ManagedWorkload[]> {
    return Promise.resolve(this.workloads);
  }

  listNetworks(): Promise<ManagedNetwork[]> {
    return Promise.resolve(this.networks);
  }

  removeNetwork(id: string): Promise<void> {
    this.removedNetworks.push(id);
    this.networks = this.networks.filter((network) => network.id !== id);
    return Promise.resolve();
  }
}

export class RecordingProcess implements RunningProcess {
  ended = false;
  detached = false;

  private readonly outputs: ((output: ProcessOutput) => void)[] = [];
  private readonly exits: ((code: number | null) => void)[] = [];

  constructor(readonly options: StartProcessOptions) {}

  onOutput(listener: (output: ProcessOutput) => void): void {
    this.outputs.push(listener);
  }

  onExit(listener: (code: number | null) => void): void {
    this.exits.push(listener);
  }

  detach(): Promise<void> {
    this.detached = true;
    return Promise.resolve();
  }

  emit(text: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    const chunk = new TextEncoder().encode(text);
    for (const listener of this.outputs) listener({ stream, chunk });
  }

  end(code: number | null): void {
    if (this.ended) return;
    this.ended = true;
    for (const listener of this.exits) listener(code);
  }
}

export class RecordingTerminal implements TerminalSession {
  readonly written: string[] = [];
  readonly sizes: TerminalSize[] = [];
  closed = false;
  ended = false;

  private data: ((chunk: Uint8Array) => void) | undefined;
  private exit: ((code: number | null) => void) | undefined;

  constructor(
    readonly externalId: string,
    readonly options: TerminalOptions,
  ) {
    this.sizes.push(options.size);
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.data = listener;
  }

  onExit(listener: (code: number | null) => void): void {
    this.exit = listener;
  }

  write(data: string): void {
    this.written.push(data);
    this.emit(data);
  }

  resize(size: TerminalSize): Promise<void> {
    this.sizes.push(size);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  emit(text: string): void {
    this.data?.(new TextEncoder().encode(text));
  }

  end(code: number | null): void {
    this.ended = true;
    this.exit?.(code);
  }
}
