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

/**
 * The project's own application.
 *
 * A runtime is the environment; this is the program inside it. They are kept
 * apart deliberately, and the reason shows up at the worst moment: when an
 * application has crashed, someone needs a terminal in that container, the
 * files as they now are, and the output that explains it. A design where the
 * application *is* the container takes all three away exactly then.
 *
 * Two properties are maintained here:
 *
 * - **Nothing is reported running that was not observed running.** The state
 *   is reconciled against the container before it is answered, so a control
 *   plane that restarted does not keep insisting on what it last saw.
 * - **Output is never invented.** What the program printed is what is shown,
 *   and when the buffer has dropped older lines it says so rather than
 *   presenting a partial log as a whole one.
 */

export interface RunServiceOptions {
  /** How long the application is given to stop before it is killed. */
  stopGraceSeconds: number;
  /** How much output is kept for a client that connects late. */
  bufferBytes: number;
  bufferLines: number;
}

/** Told whenever the run state changes, so sockets can push it. */
export type RunListener = (event: {
  projectId: string;
  status: RunStatus;
  exitCode: number | null;
}) => void;

export class RunService {
  /**
   * The processes this control plane is watching, and what they printed.
   *
   * In memory, and keyed by runtime rather than by project, so restarting a
   * runtime starts a fresh log rather than continuing the last one. Lost when
   * the control plane restarts; the program itself is not, which is why the
   * state is reconciled rather than assumed. Durable logs are their own task.
   */
  private readonly attached = new Map<string, RunningProcess>();
  private readonly buffers = new Map<string, OutputBuffer>();
  private readonly outputListeners = new Map<string, Set<(line: OutputLine) => void>>();
  /**
   * Runtimes whose program the platform is deliberately ending.
   *
   * The exit handler and the stop both want to write down how the program
   * finished, and they disagree: a signalled program reports a failure code,
   * and being stopped on purpose is not a failure. The stop is the account
   * that is true, so the handler stands aside while one is in progress.
   */
  private readonly stopping = new Set<string>();
  /**
   * Runtimes this process is in the middle of starting a program on.
   *
   * Reconciliation asks the container whether anything is running and believes
   * the answer. Between writing down that a run is starting and having a
   * process to watch, that answer is "no" for a reason that is not the one
   * reconciliation assumes, and acting on it loses the run that is starting.
   */
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

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /**
   * What the application is doing, and what it would run.
   *
   * Reconciles first. The program lives in the container, so the database's
   * view of it can be stale in ways the runtime's own status cannot be.
   */
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

  /** Everything the program has printed that is still held. */
  history(runtimeId: string): { lines: OutputLine[]; truncated: boolean } {
    const buffer = this.buffers.get(runtimeId);
    return buffer ? buffer.read() : { lines: [], truncated: false };
  }

  /** The runtime a project is using, for a socket that needs to key on it. */
  async runtimeIdFor(projectId: string): Promise<string | undefined> {
    const record = await this.runtimes.findByProject(projectId);
    return record?.id;
  }

  // -------------------------------------------------------------------------
  // Acting
  // -------------------------------------------------------------------------

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

  /**
   * Starts the project's application.
   *
   * Refuses rather than restarting when one is already running: two would make
   * "is it running" unanswerable and leave the first with nothing able to stop
   * it.
   */
  async start(projectId: string): Promise<RunState> {
    const runtime = await this.reconcile(projectId);

    if (!runtime || runtime.status !== 'RUNNING' || !runtime.externalId) {
      throw new AppError('PRECONDITION_FAILED', 'Start the project before running it.');
    }

    if (runtime.runStatus === 'RUNNING' || runtime.runStatus === 'STARTING') {
      throw new AppError('CONFLICT', 'This project is already running. Stop it first.');
    }

    const command = await this.resolveCommand(projectId, runtime);

    // A fresh log for a fresh run. Keeping the last one would have someone
    // reading an error from a program that is no longer the one running.
    const buffer = new OutputBuffer(this.options.bufferBytes, this.options.bufferLines);
    this.buffers.set(runtime.id, buffer);

    this.starting.add(runtime.id);
    try {
      return await this.begin(projectId, runtime, runtime.externalId, command, buffer);
    } finally {
      this.starting.delete(runtime.id);
    }
  }

  /** The start itself, with the guard against reconciliation already up. */
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
      // What was listening belonged to the last program.
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

    /*
     * A gate the exit handler waits on.
     *
     * A program can finish before the start has finished writing down that it
     * began. Without this the two writes race, and when the start's lands last
     * a program that has already exited is left recorded as running.
     */
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

  /**
   * Stops the application.
   *
   * A no-op when nothing is running, because asking twice is not an error.
   */
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

  /**
   * Lets go of an application without stopping it.
   *
   * Used when the runtime itself is going away, and on shutdown. The program
   * is inside the container and dies with it; the platform only has to stop
   * watching.
   */
  async releaseRuntime(runtimeId: string): Promise<void> {
    await this.release(runtimeId);
    this.buffers.delete(runtimeId);
    this.outputListeners.delete(runtimeId);
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  onOutput(runtimeId: string, listener: (line: OutputLine) => void): () => void {
    const listeners = this.outputListeners.get(runtimeId) ?? new Set();
    listeners.add(listener);
    this.outputListeners.set(runtimeId, listeners);
    return () => listeners.delete(listener);
  }

  /**
   * Where output is written down, when there is anywhere to write it.
   *
   * Optional and set after construction, following the pattern the runtime
   * service already uses for its own collaborators: a run service built for a
   * unit test keeps no log and should not have to be handed one to say so.
   */
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

  // -------------------------------------------------------------------------

  /**
   * Brings the database's view of the application into line with the container.
   *
   * The one place that can correct a stale RUNNING, which happens whenever the
   * control plane restarts while a program is up, or the program exits while
   * nothing is watching.
   */
  private async reconcile(projectId: string): Promise<RuntimeRecord | null> {
    const runtime = await this.runtimes.findByProject(projectId);
    if (!runtime) return null;

    const settled = runtime.runStatus !== 'RUNNING' && runtime.runStatus !== 'STARTING';
    if (settled) return runtime;

    // The container is gone, so the program inside it is too.
    if (runtime.status !== 'RUNNING' || !runtime.externalId) {
      return this.markStopped(runtime, 'The runtime stopped.');
    }

    // Watching it, or about to be, is proof enough and cheaper than asking.
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

  /** Wires a started process into the buffer and the subscribers. */
  private attach(
    projectId: string,
    runtimeId: string,
    process: RunningProcess,
    buffer: OutputBuffer,
    /** Settles once the start has finished recording itself. */
    started: Promise<void>,
  ): void {
    this.attached.set(runtimeId, process);

    process.onOutput(({ stream, chunk }) => {
      const line = buffer.append(stream as OutputStream, chunk);
      if (!line) return;

      for (const listener of this.outputListeners.get(runtimeId) ?? []) listener(line);

      /*
       * Written down as well as shown.
       *
       * The buffer above is a window onto a running program and is gone when
       * the control plane restarts; this is the durable copy. Both are fed from
       * the same stream so they cannot disagree about what was printed, and
       * recording never throws, because there is nobody here to tell.
       */
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

        // Asked for, so the stop records it. Writing here as well would say
        // the program failed, which is what being signalled looks like from
        // the inside and not what happened.
        // Left attached on purpose: the stop lets go of it a moment later, and
        // until it does this is still the program this runtime has.
        if (this.stopping.has(runtimeId)) return;

        try {
          await this.runtimes.setRunState(runtimeId, {
            runStatus: code === 0 || code === null ? 'EXITED' : 'FAILED',
            runExitedAt: new Date(),
            runExitCode: code,
            runMessage:
              code === 0 ? 'Finished.' : code === null ? 'Ended.' : `Exited with code ${code}.`,
            // Whatever was listening belonged to this program.
            previewPort: null,
          });
        } catch (error) {
          this.log.error({ err: error, projectId }, 'could not record the application exit');
        }
        /*
         * Only now.
         *
         * While the exit is being written, this process is still the one this
         * runtime has. Forgetting it first leaves a window in which a read
         * finds a database that says RUNNING and nothing attached, concludes
         * the platform was restarted, and overwrites the real exit code with
         * that guess. A program that exits quickly hits that window every time.
         */
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

  /** What would be run, from the project's own setting or from the suggestion. */
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

  /**
   * What the platform would run, and why.
   *
   * Reads the project's own package.json when there is one, because a start
   * script somebody wrote beats any filename the platform recognises.
   */
  private async suggest(
    projectId: string,
    runtime: RuntimeRecord | null,
  ): Promise<RunSuggestion | undefined> {
    const tree = await this.files.listTree(projectId);
    const paths = tree.entries.filter((entry) => entry.type === 'FILE').map((entry) => entry.path);

    /*
     * The runtime's language when there is one, and the files' when there is
     * not.
     *
     * Someone looking at a project nobody has started still wants to know what
     * pressing Run would do, and the files are the same evidence the platform
     * uses to choose an image in the first place.
     */
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
      } catch {
        // A manifest that cannot be read is a manifest that decides nothing.
      }
    }

    return suggestRunCommand(language, { paths, ...manifest });
  }

  /** Why running is not possible right now, or null when it is. */
  private blockedReason(
    runtime: RuntimeRecord | null,
    configured: string | null,
    suggestion: RunSuggestion | undefined,
  ): string | null {
    if (!runtime || runtime.status !== 'RUNNING') {
      return 'Start the project before running it.';
    }
    if (!configured && !suggestion) {
      return 'This project does not say how to start. Set a run command in settings.';
    }
    return null;
  }

  private userFacing(error: unknown, fallback: string): string {
    return error instanceof AppError && error.expose ? error.message : fallback;
  }
}
