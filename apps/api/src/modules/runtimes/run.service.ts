import {
  detectRuntime,
  readPackageJson,
  suggestRunCommand,
  isRuntimeLanguage,
  runCommandSchema,
  type OutputStream,
  type RunState,
  type RunStatus,
  type RunSuggestion,
} from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { ExecutionProvider, RunningProcess } from '../../execution/provider.js';
import type { FileService } from '../files/file.service.js';
import type { ProjectRepository } from '../projects/project.repository.js';
import type { RuntimeRecord, RuntimeRepository } from './runtime.repository.js';
import { OutputBuffer, type OutputLine } from './output-buffer.js';

export interface RunServiceOptions {
  stopGraceSeconds: number;
  bufferBytes: number;
  bufferLines: number;
}

export type RunListener = (event: {
  projectId: string;
  status: RunStatus;
  exitCode: number | null;
}) => void;

export class RunService {
  private readonly attached = new Map<string, RunningProcess>();
  private readonly buffers = new Map<string, OutputBuffer>();
  private readonly outputListeners = new Map<string, Set<(line: OutputLine) => void>>();
  private readonly stopping = new Set<string>();
  private readonly starting = new Set<string>();
  private readonly runListeners = new Set<RunListener>();

  constructor(
    private readonly runtimes: RuntimeRepository,
    private readonly projects: ProjectRepository,
    private readonly files: FileService,
    private readonly provider: ExecutionProvider,
    private readonly options: RunServiceOptions,
    private readonly log: Logger,
  ) {}

  async describe(projectId: string): Promise<RunState> {
    const runtime = await this.reconcile(projectId);
    const project = await this.projects.findById(projectId);
    const suggestion = await this.suggest(projectId, runtime);

    const blockedReason = this.blockedReason(runtime, project?.runCommand ?? null, suggestion);

    return {
      status: runtime?.runStatus ?? 'IDLE',
      command: runtime?.runCommand ?? null,
      configuredCommand: project?.runCommand ?? null,
      suggestion: suggestion ?? null,
      startedAt: runtime?.runStartedAt?.toISOString() ?? null,
      exitedAt: runtime?.runExitedAt?.toISOString() ?? null,
      exitCode: runtime?.runExitCode ?? null,
      message: runtime?.runMessage ?? null,
      blockedReason,
    };
  }

  history(runtimeId: string): { lines: OutputLine[]; truncated: boolean } {
    const buffer = this.buffers.get(runtimeId);
    return buffer ? buffer.read() : { lines: [], truncated: false };
  }

  async runtimeIdFor(projectId: string): Promise<string | undefined> {
    const record = await this.runtimes.findByProject(projectId);
    return record?.id;
  }

  async setCommand(projectId: string, command: string | null): Promise<RunState> {
    if (command !== null) {
      const parsed = runCommandSchema.safeParse(command);
      if (!parsed.success) {
        throw new AppError('VALIDATION_FAILED', 'That command cannot be used', {
          details: {
            fields: [
              { path: 'command', message: parsed.error.issues[0]?.message ?? 'Invalid command' },
            ],
          },
        });
      }
      await this.projects.setRunCommand(projectId, parsed.data);
    } else {
      await this.projects.setRunCommand(projectId, null);
    }

    return this.describe(projectId);
  }

  async start(projectId: string): Promise<RunState> {
    const runtime = await this.reconcile(projectId);

    if (!runtime || runtime.status !== 'RUNNING' || !runtime.externalId) {
      throw new AppError('PRECONDITION_FAILED', 'Start the environment before running the app.');
    }

    if (runtime.runStatus === 'RUNNING' || runtime.runStatus === 'STARTING') {
      throw new AppError('CONFLICT', 'This project is already running. Stop it first.');
    }

    const command = await this.resolveCommand(projectId, runtime);

    const buffer = new OutputBuffer(this.options.bufferBytes, this.options.bufferLines);
    this.buffers.set(runtime.id, buffer);

    this.starting.add(runtime.id);
    try {
      return await this.begin(projectId, runtime, runtime.externalId, command, buffer);
    } finally {
      this.starting.delete(runtime.id);
    }
  }

  private async begin(
    projectId: string,
    runtime: RuntimeRecord,
    externalId: string,
    command: string,
    buffer: OutputBuffer,
  ): Promise<RunState> {
    await this.runtimes.setRunState(runtime.id, {
      runStatus: 'STARTING',
      runCommand: command,
      runStartedAt: new Date(),
      runExitedAt: null,
      runExitCode: null,
      runMessage: null,
      previewPort: null,
    });
    this.announce(projectId, 'STARTING', null);

    let process: RunningProcess;
    try {
      process = await this.provider.startProcess({ externalId }, { command });
    } catch (error) {
      const message = this.userFacing(error, 'The application could not be started.');
      await this.runtimes.setRunState(runtime.id, {
        runStatus: 'FAILED',
        runExitedAt: new Date(),
        runMessage: message.slice(0, 500),
      });
      this.announce(projectId, 'FAILED', null);
      throw new AppError('EXECUTION_FAILED', message, { expose: true, cause: error });
    }

    let opened!: () => void;
    const started = new Promise<void>((resolve) => {
      opened = resolve;
    });

    this.attach(projectId, runtime.id, process, buffer, started);

    try {
      await this.runtimes.setRunState(runtime.id, { runStatus: 'RUNNING' });
      this.announce(projectId, 'RUNNING', null);
    } finally {
      opened();
    }

    return this.describe(projectId);
  }

  async stop(projectId: string): Promise<RunState> {
    const runtime = await this.reconcile(projectId);

    if (!runtime || !runtime.externalId) return this.describe(projectId);

    if (runtime.runStatus !== 'RUNNING' && runtime.runStatus !== 'STARTING') {
      return this.describe(projectId);
    }

    this.stopping.add(runtime.id);
    try {
      await this.provider.stopProcess(
        { externalId: runtime.externalId },
        this.options.stopGraceSeconds,
      );
    } catch (error) {
      this.stopping.delete(runtime.id);
      this.log.error({ err: error, projectId }, 'the application could not be stopped');
      throw new AppError('EXECUTION_FAILED', 'The application could not be stopped.', {
        expose: true,
        cause: error,
      });
    }

    try {
      await this.release(runtime.id);
      await this.runtimes.setRunState(runtime.id, {
        runStatus: 'EXITED',
        runExitedAt: new Date(),
        runExitCode: null,
        runMessage: 'Stopped.',
        previewPort: null,
      });
    } finally {
      this.stopping.delete(runtime.id);
    }
    this.announce(projectId, 'EXITED', null);

    return this.describe(projectId);
  }

  async releaseRuntime(runtimeId: string): Promise<void> {
    await this.release(runtimeId);
    this.buffers.delete(runtimeId);
    this.outputListeners.delete(runtimeId);
  }

  onOutput(runtimeId: string, listener: (line: OutputLine) => void): () => void {
    const listeners = this.outputListeners.get(runtimeId) ?? new Set();
    listeners.add(listener);
    this.outputListeners.set(runtimeId, listeners);
    return () => listeners.delete(listener);
  }

  private logs:
    | {
        record(input: {
          projectId: string;
          source: 'RUN';
          sourceId: string;
          stream: 'stdout' | 'stderr';
          chunk: string;
        }): void;
      }
    | undefined;

  useLogs(logs: NonNullable<typeof this.logs>): void {
    this.logs = logs;
  }

  onRunChange(listener: RunListener): () => void {
    this.runListeners.add(listener);
    return () => this.runListeners.delete(listener);
  }

  private async reconcile(projectId: string): Promise<RuntimeRecord | null> {
    const runtime = await this.runtimes.findByProject(projectId);
    if (!runtime) return null;

    const settled = runtime.runStatus !== 'RUNNING' && runtime.runStatus !== 'STARTING';
    if (settled) return runtime;

    if (runtime.status !== 'RUNNING' || !runtime.externalId) {
      return this.markStopped(runtime, 'The runtime stopped.');
    }

    if (this.attached.has(runtime.id) || this.starting.has(runtime.id)) return runtime;

    const running = await this.provider
      .processRunning({ externalId: runtime.externalId })
      .catch(() => false);

    if (running) return runtime;

    return this.markStopped(
      runtime,
      'The application is no longer running. Its output was not kept, because the platform was restarted.',
    );
  }

  private async markStopped(runtime: RuntimeRecord, message: string): Promise<RuntimeRecord> {
    await this.release(runtime.id);
    const updated = await this.runtimes.setRunState(runtime.id, {
      runStatus: 'EXITED',
      runExitedAt: runtime.runExitedAt ?? new Date(),
      runMessage: message,
      previewPort: null,
    });
    this.announce(runtime.projectId, 'EXITED', null);
    return updated;
  }

  private attach(
    projectId: string,
    runtimeId: string,
    process: RunningProcess,
    buffer: OutputBuffer,
    started: Promise<void>,
  ): void {
    this.attached.set(runtimeId, process);

    process.onOutput(({ stream, chunk }) => {
      const line = buffer.append(stream as OutputStream, chunk);
      if (!line) return;

      for (const listener of this.outputListeners.get(runtimeId) ?? []) listener(line);

      this.logs?.record({
        projectId,
        source: 'RUN',
        sourceId: runtimeId,
        stream: line.stream,
        chunk: line.data,
      });
    });

    process.onExit((code) => {
      void (async () => {
        await started;

        if (this.stopping.has(runtimeId)) return;

        try {
          await this.runtimes.setRunState(runtimeId, {
            runStatus: code === 0 || code === null ? 'EXITED' : 'FAILED',
            runExitedAt: new Date(),
            runExitCode: code,
            runMessage:
              code === 0 ? 'Finished.' : code === null ? 'Ended.' : `Exited with code ${code}.`,
            previewPort: null,
          });
        } catch (error) {
          this.log.error({ err: error, projectId }, 'could not record the application exit');
        }
        this.attached.delete(runtimeId);
        this.announce(projectId, code === 0 || code === null ? 'EXITED' : 'FAILED', code);
      })();
    });
  }

  private async release(runtimeId: string): Promise<void> {
    const process = this.attached.get(runtimeId);
    if (!process) return;
    this.attached.delete(runtimeId);
    await process.detach().catch(() => undefined);
  }

  private announce(projectId: string, status: RunStatus, exitCode: number | null): void {
    for (const listener of this.runListeners) {
      try {
        listener({ projectId, status, exitCode });
      } catch (error) {
        this.log.warn({ err: error, projectId }, 'a run listener threw');
      }
    }
  }

  private async resolveCommand(projectId: string, runtime: RuntimeRecord): Promise<string> {
    const project = await this.projects.findById(projectId);
    if (project?.runCommand) return project.runCommand;

    const suggestion = await this.suggest(projectId, runtime);
    if (suggestion) return suggestion.command;

    throw new AppError(
      'PRECONDITION_FAILED',
      'This project does not say how to start. Set a run command, or add an entry point the platform recognises.',
    );
  }

  private async suggest(
    projectId: string,
    runtime: RuntimeRecord | null,
  ): Promise<RunSuggestion | undefined> {
    const tree = await this.files.listTree(projectId);
    const paths = tree.entries.filter((entry) => entry.type === 'FILE').map((entry) => entry.path);

    const language =
      runtime && isRuntimeLanguage(runtime.language)
        ? runtime.language
        : detectRuntime(paths)?.language;
    if (!language) return undefined;

    let manifest = {};
    if (paths.includes('package.json')) {
      try {
        const file = await this.files.read(projectId, 'package.json');
        if (file.encoding === 'utf8') manifest = readPackageJson(file.content);
      } catch {}
    }

    return suggestRunCommand(language, { paths, ...manifest });
  }

  private blockedReason(
    runtime: RuntimeRecord | null,
    configured: string | null,
    suggestion: RunSuggestion | undefined,
  ): string | null {
    if (!runtime || runtime.status !== 'RUNNING') {
      return 'Start the environment before running the app.';
    }
    if (!configured && !suggestion) {
      return 'This project does not say how to start. Set a run command in the console.';
    }
    return null;
  }

  private userFacing(error: unknown, fallback: string): string {
    return error instanceof AppError && error.expose ? error.message : fallback;
  }
}
