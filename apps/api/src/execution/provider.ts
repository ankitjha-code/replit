import type { ResourceLimits, TerminalSize } from '@platform/shared';

export interface WorkspaceEntry {
  path: string;
  content: Uint8Array | null;
}

export interface WorkspaceFile {
  path: string;
  content: Uint8Array;
}

export interface TerminalSession {
  onData(listener: (chunk: Uint8Array) => void): void;
  onExit(listener: (code: number | null) => void): void;
  write(data: string): void;
  resize(size: TerminalSize): Promise<void>;
  close(): Promise<void>;
}

export interface TerminalOptions {
  size: TerminalSize;
  cwd?: string;
}

export interface PublishedPort {
  containerPort: number;
  host: string;
  port: number;
}

export interface ProcessOutput {
  stream: 'stdout' | 'stderr';
  chunk: Uint8Array;
}

export interface RunningProcess {
  onOutput(listener: (output: ProcessOutput) => void): void;
  onExit(listener: (code: number | null) => void): void;
  detach(): Promise<void>;
}

export interface StartProcessOptions {
  command: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}

export interface ExecutionHandle {
  externalId: string;

  host?: string;
}

export type WorkloadKind = 'runtime' | 'deployment';

export interface ProvisionRequest {
  workloadId: string;
  kind: WorkloadKind;
  projectId: string;
  image: string;
  limits: ResourceLimits;

  command?: string | undefined;
  env: Readonly<Record<string, string>>;
}

export interface WorkloadStats {
  cpuMillicores: number | null;
  memoryBytes: number | null;
  pids: number | null;
  at: Date;
}

export type ProviderState = 'absent' | 'created' | 'running' | 'exited';

export interface ManagedWorkload {
  externalId: string;
  kind: WorkloadKind | 'unknown';
  workloadId: string | undefined;
  projectId: string | undefined;
  state: ProviderState;
  createdAt: Date | undefined;
}

export interface ManagedNetwork {
  id: string;
  name: string;
  projectId: string | undefined;
  attached: number;
  createdAt: Date | undefined;
}

export interface ExecutionProvider {
  readonly name: string;

  unavailableReason(): Promise<string | null>;

  create(request: ProvisionRequest): Promise<ExecutionHandle>;

  seedWorkspace(handle: ExecutionHandle, entries: readonly WorkspaceEntry[]): Promise<void>;

  start(handle: ExecutionHandle): Promise<void>;

  stop(handle: ExecutionHandle, graceSeconds: number): Promise<void>;

  destroy(handle: ExecutionHandle): Promise<void>;

  inspect(handle: ExecutionHandle): Promise<ProviderState>;

  readWorkspace(handle: ExecutionHandle): Promise<WorkspaceFile[]>;

  stats(handle: ExecutionHandle): Promise<WorkloadStats | null>;

  diskUsage(handle: ExecutionHandle): Promise<number | null>;

  readDirectory(handle: ExecutionHandle, directory: string): Promise<WorkspaceFile[]>;

  publishedPorts(handle: ExecutionHandle): Promise<PublishedPort[]>;

  startProcess(handle: ExecutionHandle, options: StartProcessOptions): Promise<RunningProcess>;

  stopProcess(handle: ExecutionHandle, graceSeconds: number): Promise<void>;

  processRunning(handle: ExecutionHandle): Promise<boolean>;

  openTerminal(handle: ExecutionHandle, options: TerminalOptions): Promise<TerminalSession>;

  startTerminal(
    handle: ExecutionHandle,
    terminalId: string,
    options: TerminalOptions,
  ): Promise<void>;

  attachTerminal(handle: ExecutionHandle, terminalId: string): Promise<TerminalSession>;

  stopTerminal(handle: ExecutionHandle, terminalId: string): Promise<void>;

  terminalRunning(handle: ExecutionHandle, terminalId: string): Promise<boolean>;

  listWorkloads(): Promise<ManagedWorkload[]>;

  listNetworks(): Promise<ManagedNetwork[]>;

  removeNetwork(id: string): Promise<void>;
}
