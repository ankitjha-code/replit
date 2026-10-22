import {
  DEFAULT_RESOURCE_LIMITS,
  RUNTIME_DEFINITIONS,
  RUNTIME_TRANSITIONS,
  canTransition,
  detectRuntime,
  isRuntimeLanguage,
  type ResourceLimits,
  type RuntimeDetection,
  type RuntimeLanguage,
  type RuntimeStateResponse,
  type RuntimeStatus,
  type RuntimeSummary,
  type TerminalSize,
  type WorkspaceSyncResult,
} from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { ProjectEventPublisher } from '../../events/project-event-bus.js';
import type { ExecutionProvider, TerminalSession } from '../../execution/provider.js';
import type { FileService } from '../files/file.service.js';
import type { RuntimeRecord, RuntimeRepository } from './runtime.repository.js';

/**
 * What the runtime needs from secrets, and nothing more.
 *
 * Declared here rather than importing the service, so this module cannot
 * reach a method that hands values back to a caller.
 */
export interface SecretProvider {
  forRuntime(projectId: string): Promise<Record<string, string>>;
}

/**
 * What the runtime needs from plain environment variables.
 *
 * The same shape as the secret port above, and separate from it on purpose:
 * the two are merged into one environment but they are not the same kind of
 * thing, and a single port would invite a future change that treats them
 * alike.
 */
export interface VariableProvider {
  forRuntime(projectId: string): Promise<Record<string, string>>;
}

/**
 * What the runtime needs from the project's own database.
 *
 * A third source with the same shape, and the one whose values the platform
 * generated rather than a person. It is applied first, so a project cannot end
 * up unable to reach its own database because something else claimed the name;
 * setting a name a database uses is refused outright elsewhere, which is what
 * makes that ordering a backstop rather than a rule.
 */
export interface DatabaseEnvProvider {
  forRuntime(projectId: string): Promise<Record<string, string>>;
}

/**
 * The runtime lifecycle.
 *
 * This service owns every rule about how a project's development environment
 * moves between states. It decides; an execution provider carries out. The
 * separation is what lets the platform know what should exist even when the
 * thing that runs containers is absent, broken or being replaced.
 *
 * Three properties are maintained deliberately:
 *
 * - **The database is never ahead of reality.** A runtime is marked running
 *   only after the provider has actually started it. Nothing is recorded
 *   optimistically, because a status nobody verified is a status that lies.
 * - **A failure is recorded, not swallowed.** Every failed start leaves a
 *   FAILED row with a reason someone can read, and an event row saying when.
 * - **Two requests cannot both win.** Every transition names the state and
 *   revision it expects, so a race is detected rather than resolved by
 *   whichever write landed second.
 */

export interface RuntimeServiceOptions {
  limits: ResourceLimits;
  stopGraceSeconds: number;
}

export const DEFAULT_RUNTIME_OPTIONS: RuntimeServiceOptions = {
  limits: DEFAULT_RESOURCE_LIMITS,
  stopGraceSeconds: 10,
};

export class RuntimeService {
  constructor(
    private readonly runtimes: RuntimeRepository,
    private readonly files: FileService,
    private readonly secrets: SecretProvider,
    private readonly variables: VariableProvider,
    private readonly databases: DatabaseEnvProvider,
    private readonly provider: ExecutionProvider,
    private readonly options: RuntimeServiceOptions,
    private readonly log: Logger,
  ) {}

  /**
   * Everything known about a project's ability to run.
   *
   * Answers three separate questions, because a client needs all three to say
   * anything true: does this project have a runtime, what runtime does it
   * appear to need, and can this installation start one at all.
   */
  async describe(projectId: string): Promise<RuntimeStateResponse> {
    const [record, detected, reason] = await Promise.all([
      this.runtimes.findByProject(projectId),
      this.detect(projectId),
      this.provider.unavailableReason(),
    ]);

    return {
      runtime: record ? toSummary(record) : null,
      detected,
      provider: { name: this.provider.name, available: reason === null, reason },
    };
  }

  /** Which runtime the project's files say it needs, if any of them say. */
  async detect(projectId: string): Promise<RuntimeDetection | null> {
    const tree = await this.files.listTree(projectId);
    const paths = tree.entries.filter((entry) => entry.type === 'FILE').map((entry) => entry.path);
    return detectRuntime(paths);
  }

  /**
   * Starts a project's development environment.
   *
   * Refuses before writing anything when there is no execution backend. An
   * installation that cannot run code should not accumulate runtime rows
   * describing containers that will never exist.
   */
  async start(
    projectId: string,
    actorId: string,
    override?: RuntimeLanguage,
  ): Promise<RuntimeStateResponse> {
    await this.requireProvider();

    const existing = await this.runtimes.findByProject(projectId);

    // Already there, or already on its way. Saying yes twice to the same
    // request is better than starting a second container for it.
    if (existing && (existing.status === 'RUNNING' || isInFlight(existing.status))) {
      return this.describe(projectId);
    }

    /*
     * The account's ceiling, before anything is written.
     *
     * After the "already running" check above, so pressing Start twice on a
     * project that is already up is never refused for being over a limit it is
     * not adding to. Before the row is created, following the rule the rest of
     * the platform keeps: something that cannot happen must not leave a record
     * of having been asked.
     */
    await this.quotas?.require(projectId, 'RUNTIMES');

    const spec = await this.resolveSpec(projectId, override);

    let runtime: RuntimeRecord;
    if (existing) {
      runtime = await this.reuse(existing, spec, actorId);
    } else {
      const created = await this.runtimes.create({
        projectId,
        provider: this.provider.name,
        language: spec.language,
        version: spec.version,
        image: spec.image,
        cpuMillicores: this.options.limits.cpuMillicores,
        memoryMb: this.options.limits.memoryMb,
        pidsLimit: this.options.limits.pidsLimit,
        requestedById: actorId,
      });

      // Another request created it first. That is the answer this one wanted,
      // so it reports what is there rather than failing or starting a second
      // container for the same project.
      if (!created.ok) return this.describe(projectId);
      runtime = created.runtime;
    }

    /*
     * Recorded as requested, then handed to a worker.
     *
     * The runtime row is already REQUESTED at this point, which is a state the
     * client knows how to show and already polls out of: the workspace polls
     * while a runtime is transitional, and has since runtimes existed. So
     * nothing about the browser changes — the request simply stops being the
     * thing that waits for an image to pull.
     *
     * With no queue configured the work happens here, in the request, exactly as
     * it used to. Slower and still correct.
     */
    if (this.queue) {
      await this.queue.enqueue('RUNTIME_START', { runtimeId: runtime.id, actorId }, { projectId });
    } else {
      await this.provision(runtime, actorId);
    }

    return this.describe(projectId);
  }

  /**
   * Creates and starts the container for a runtime that has been requested.
   *
   * The half of `start` a worker does. Public because the worker is outside this
   * service and inside the platform; it is not a route and nothing reaches it
   * from a request.
   *
   * Reloads the row rather than trusting what it was handed. A job may be picked
   * up a second after it was queued or a minute after a restart, and in between
   * somebody may have stopped the runtime or started it another way.
   */
  async provisionRequested(runtimeId: string, actorId: string): Promise<void> {
    const runtime = await this.runtimes.findById(runtimeId);

    if (!runtime) {
      // The project, or the runtime, went away while this was queued. Nothing to
      // do and nothing wrong: the work is no longer wanted.
      this.log.info({ runtimeId }, 'a queued runtime start had nothing to start');
      return;
    }

    if (runtime.status !== 'REQUESTED') {
      // Somebody else moved it on: started it in the request, stopped it, or a
      // duplicate job got here first. Any of those is an outcome rather than a
      // failure.
      this.log.info(
        { runtimeId, status: runtime.status },
        'a queued runtime start found the runtime already moved on',
      );
      return;
    }

    await this.provision(runtime, actorId);
  }

  /**
   * Records that a requested runtime is never going to start.
   *
   * Called when the work to start it was given up on: its attempts ran out, or
   * the worker holding it died with none left. Without this the row sits in
   * REQUESTED for ever, looking to everybody like a container that is about to
   * appear.
   *
   * Only from REQUESTED. Anything further along was moved by something that knew
   * more than this does — a provisioning attempt that got as far as CREATING
   * records its own failure — and overwriting that would replace a real reason
   * with a vaguer one.
   */
  async abandonRequested(runtimeId: string, reason: string): Promise<void> {
    const record = await this.runtimes.findById(runtimeId);
    if (!record || record.status !== 'REQUESTED') return;

    await this.move(record, 'FAILED', {
      actorId: record.requestedById,
      message: reason,
      reason: 'Abandoned',
      stoppedAt: new Date(),
    });

    this.log.warn({ runtimeId, projectId: record.projectId }, 'a requested runtime was abandoned');
  }

  /**
   * Stops a project's development environment.
   *
   * A no-op when there is nothing running, because asking twice for something
   * to be stopped is not an error.
   */
  /**
   * Lets go of everything a project's environment holds, for deleting the project.
   *
   * Not a stop. A stop reads the files back and moves the row through its
   * states, because the project goes on existing; here the project is about to
   * disappear, the row cascades with it, and reading files back into a project
   * that is being deleted would be work for nobody.
   *
   * Three things live outside the database and would outlast the project if
   * nothing removed them: the container, the shells and program inside it, and
   * the project's own network. Found missing by deleting a project against a
   * real daemon and looking at what was left — the container sat there exited,
   * and the network stayed for ever.
   *
   * Never throws. A project must stay deletable when the container runtime is
   * unreachable; what is left behind is exactly what the cleanup sweep finds.
   */
  async releaseProject(projectId: string): Promise<void> {
    const existing = await this.runtimes.findByProject(projectId).catch(() => null);

    if (existing) {
      await this.runs?.releaseRuntime(existing.id).catch(() => undefined);
      await this.terminals?.releaseRuntime(existing.id).catch(() => undefined);

      if (existing.externalId) {
        await this.provider.destroy({ externalId: existing.externalId }).catch((error: unknown) => {
          this.log.error(
            { err: error, projectId, runtimeId: existing.id },
            "a deleted project's container could not be removed; the cleanup sweep will find it",
          );
        });
      }
    }

    try {
      for (const network of await this.provider.listNetworks()) {
        if (network.projectId !== projectId) continue;
        await this.provider.removeNetwork(network.id);
      }
    } catch (error) {
      this.log.error(
        { err: error, projectId },
        "a deleted project's network could not be removed; the cleanup sweep will find it",
      );
    }
  }

  async stop(projectId: string, actorId: string, reason?: string): Promise<RuntimeStateResponse> {
    const existing = await this.runtimes.findByProject(projectId);

    if (!existing || existing.status === 'STOPPED' || existing.status === 'FAILED') {
      return this.describe(projectId);
    }

    if (existing.status !== 'RUNNING') {
      throw new AppError(
        'CONFLICT',
        'This runtime is still changing state. Wait for it to settle, then try again.',
      );
    }

    // Nothing was ever created for it, so there is nothing to ask the provider
    // about. Recording the truth beats calling a provider with a null handle.
    if (!existing.externalId) {
      await this.move(existing, 'STOPPING', { actorId, message: null });
      const stopping = await this.reload(existing.id);
      await this.move(stopping, 'STOPPED', {
        actorId,
        message: null,
        stoppedAt: new Date(),
        reason: 'No workload had been created',
      });
      return this.describe(projectId);
    }

    await this.requireProvider();

    /*
     * Let go of the application first.
     *
     * It dies with the container either way; this only stops the platform
     * watching a stream that is about to end, and clears the run state so
     * nothing reports a program running inside a container that is gone.
     */
    await this.runs?.releaseRuntime(existing.id);

    /*
     * And the shells in it.
     *
     * A session outlives its socket now, so nothing else would close one when
     * the container it lives in is destroyed. Left alone, the platform would
     * go on offering to resume a shell that no longer has anywhere to run.
     */
    await this.terminals?.releaseRuntime(existing.id);

    /*
     * Read the files back before the container goes.
     *
     * Stopping is the last moment anything inside it can be recovered, and
     * somebody who ran an install and then pressed Stop should not lose it.
     *
     * A failure here is logged and does not stop the stop. Refusing to stop a
     * runtime because its files could not be read would leave a container
     * running that someone asked to be rid of, with no way to make it go.
     */
    try {
      const result = await this.files.applyFromRuntime(
        projectId,
        await this.provider.readWorkspace({ externalId: existing.externalId }),
      );
      this.log.info({ projectId, ...summarise(result) }, 'workspace read back before stopping');
    } catch (error) {
      this.log.error(
        { err: error, projectId },
        'could not read the workspace back before stopping',
      );
    }

    const stopping = await this.move(existing, 'STOPPING', { actorId, message: null });

    try {
      await this.provider.stop({ externalId: existing.externalId }, this.options.stopGraceSeconds);
    } catch (error) {
      await this.fail(stopping, error, actorId, 'The runtime could not be stopped.');
      throw this.userFacing(error, 'The runtime could not be stopped.');
    }

    await this.move(stopping, 'STOPPED', {
      actorId,
      message: reason ?? null,
      stoppedAt: new Date(),
    });
    return this.describe(projectId);
  }

  /**
   * Stops every environment that has written more than it may.
   *
   * Measured rather than enforced by the filesystem, because only some storage
   * setups can enforce a size and one popular one silently does not. The cost
   * of measuring is that a fast writer can overshoot until the next check; the
   * owner is told exactly why their environment stopped, and their files were
   * already read back by the stop.
   */
  async enforceDiskLimit(limitBytes: number): Promise<{ checked: number; stopped: number }> {
    let checked = 0;
    let stopped = 0;
    for (const runtime of await this.runtimes.listByStatus(['RUNNING'])) {
      if (!runtime.externalId) continue;
      const used = await this.provider.diskUsage({ externalId: runtime.externalId });
      checked += 1;
      if (used === null || used <= limitBytes) continue;

      const message = `Stopped: this environment wrote ${megabytes(used)} to disk, over its ${megabytes(limitBytes)} limit. Remove large files or build output before starting it again.`;
      this.log.warn(
        { projectId: runtime.projectId, runtimeId: runtime.id, used, limitBytes },
        'an environment went over its disk limit and was stopped',
      );
      try {
        await this.stop(runtime.projectId, runtime.requestedById ?? '', message);
        stopped += 1;
      } catch (error) {
        this.log.error(
          { err: error, runtimeId: runtime.id },
          'an environment over its disk limit could not be stopped',
        );
      }
    }
    return { checked, stopped };
  }

  /**
   * The application inside the runtime, once both services exist.
   *
   * Set after construction because the two need each other: a runtime going
   * away has to release its application, and an application cannot start
   * without a runtime. Optional rather than required, so a caller that only
   * needs runtimes is not made to build one.
   */
  private runs: { releaseRuntime(runtimeId: string): Promise<void> } | undefined;

  useRunService(runs: { releaseRuntime(runtimeId: string): Promise<void> }): void {
    this.runs = runs;
  }

  /**
   * Shells open in this project's runtime, told when the runtime goes away.
   *
   * Set after construction for the same reason the run service is: a session
   * needs a runtime to open a shell in, and a runtime needs to be able to
   * close the shells it holds, so one of the two has to be introduced to the
   * other afterwards.
   */
  private terminals: { releaseRuntime(runtimeId: string): Promise<void> } | undefined;

  useTerminalSessions(terminals: { releaseRuntime(runtimeId: string): Promise<void> }): void {
    this.terminals = terminals;
  }

  /**
   * Where runtime state changes are announced, when there is anywhere to
   * announce them. Set after construction, as the two above are.
   */
  private events: ProjectEventPublisher | undefined;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }

  /**
   * Where the slow half of starting a runtime is put, when there is anywhere.
   *
   * Creating a container means pulling an image, and a first-time pull can take
   * minutes. Holding the request open for that was a recorded problem from the
   * moment runtimes existed: a browser tab is the wrong place to keep the work,
   * and a request that dies takes it with it.
   *
   * Optional, so a control plane with no job table behind it still starts
   * runtimes the old way — in the request. That is the worse behaviour and it is
   * better than no behaviour.
   */
  private queue:
    | {
        enqueue(
          type: 'RUNTIME_START',
          payload: unknown,
          options: { projectId: string },
        ): Promise<unknown>;
      }
    | undefined;

  useJobQueue(queue: NonNullable<typeof this.queue>): void {
    this.queue = queue;
  }

  /**
   * How much of the platform the project's owner may be using at once.
   *
   * Optional and set after construction, as this service's other collaborators
   * are. Without one there is no per-account ceiling and the host's own capacity
   * is the only thing bounding a start, which is the behaviour this platform had
   * before quotas existed.
   */
  private quotas: { require(projectId: string, kind: 'RUNTIMES'): Promise<void> } | undefined;

  useQuotas(quotas: NonNullable<typeof this.quotas>): void {
    this.quotas = quotas;
  }

  /**
   * Reads the runtime's files back into the project.
   *
   * The counterpart to seeding. Without it a container is where work goes to
   * disappear: a dependency install, a generator or a formatter changes files
   * that the editor never sees and that stopping the runtime throws away.
   */
  async syncWorkspace(projectId: string): Promise<WorkspaceSyncResult> {
    const record = await this.runtimes.findByProject(projectId);

    if (!record || record.status !== 'RUNNING' || !record.externalId) {
      throw new AppError('PRECONDITION_FAILED', 'Start the project before reading its files back.');
    }

    await this.requireProvider();

    const files = await this.provider.readWorkspace({ externalId: record.externalId });
    return this.files.applyFromRuntime(projectId, files);
  }

  /**
   * Opens an interactive shell in a project's runtime.
   *
   * Refuses unless the runtime is genuinely running. There is nothing to
   * attach to otherwise, and "start it first" is a far better answer than a
   * terminal that opens onto nothing.
   */
  async openTerminal(
    projectId: string,
    size: TerminalSize,
  ): Promise<{ runtimeId: string; session: TerminalSession }> {
    const record = await this.runtimes.findByProject(projectId);

    if (!record || record.status !== 'RUNNING' || !record.externalId) {
      throw new AppError('PRECONDITION_FAILED', 'Start the project before opening a terminal.');
    }

    await this.requireProvider();

    /*
     * The runtime's identity comes back with the shell.
     *
     * A caller that needs both would otherwise ask twice, and a stop landing
     * between the two answers would tie a live shell to a runtime that is
     * already gone. One lookup cannot disagree with itself.
     */
    const session = await this.provider.openTerminal({ externalId: record.externalId }, { size });
    return { runtimeId: record.id, session };
  }

  /**
   * Starts a shell that belongs to the container rather than to this process.
   *
   * The durable counterpart of `openTerminal`. It returns nothing to hold: the
   * identifier the caller generated is the whole handle, which is exactly what
   * makes the session survive this process going away.
   */
  async startDurableTerminal(
    projectId: string,
    terminalId: string,
    size: TerminalSize,
  ): Promise<{ runtimeId: string }> {
    const record = await this.requireRunning(projectId);
    await this.provider.startTerminal({ externalId: record.externalId }, terminalId, { size });
    return { runtimeId: record.id };
  }

  /** Attaches to one that is already running, wherever it was started. */
  async attachDurableTerminal(projectId: string, terminalId: string): Promise<TerminalSession> {
    const record = await this.requireRunning(projectId);
    return this.provider.attachTerminal({ externalId: record.externalId }, terminalId);
  }

  /** Whether the shell for a session is still there. */
  async durableTerminalRunning(projectId: string, terminalId: string): Promise<boolean> {
    const record = await this.runtimes.findByProject(projectId);
    if (!record || record.status !== 'RUNNING' || !record.externalId) return false;

    return this.provider
      .terminalRunning({ externalId: record.externalId }, terminalId)
      .catch(() => false);
  }

  /** Ends one. Safe when the runtime is already gone. */
  async stopDurableTerminal(projectId: string, terminalId: string): Promise<void> {
    const record = await this.runtimes.findByProject(projectId);
    if (!record || record.status !== 'RUNNING' || !record.externalId) return;

    await this.provider
      .stopTerminal({ externalId: record.externalId }, terminalId)
      .catch(() => undefined);
  }

  /** The running runtime, or a refusal a person can act on. */
  private async requireRunning(projectId: string) {
    const record = await this.runtimes.findByProject(projectId);

    if (!record || record.status !== 'RUNNING' || !record.externalId) {
      throw new AppError('PRECONDITION_FAILED', 'Start the project before opening a terminal.');
    }

    await this.requireProvider();
    return { ...record, externalId: record.externalId };
  }

  /**
   * Everything the container is started with.
   *
   * The two sources are read together so a start cannot see a variable that
   * was removed while its secret counterpart was being read, or the reverse.
   */
  private async environmentFor(projectId: string): Promise<Record<string, string>> {
    const [database, variables, secrets] = await Promise.all([
      this.databases.forRuntime(projectId),
      this.variables.forRuntime(projectId),
      this.secrets.forRuntime(projectId),
    ]);
    return { ...database, ...variables, ...secrets };
  }

  /** One runtime's transition history, most recent first. */
  async history(projectId: string) {
    const record = await this.runtimes.findByProject(projectId);
    if (!record) return [];
    return this.runtimes.listEvents(record.id);
  }

  // -------------------------------------------------------------------------

  /**
   * Walks a requested runtime through creation and starting.
   *
   * Synchronous with the request. Honest for a single control plane and a
   * local provider, and the wrong shape once starting takes minutes: that
   * belongs on a queue, with the client watching the status it already polls.
   */
  private async provision(runtime: RuntimeRecord, actorId: string): Promise<void> {
    const creating = await this.move(runtime, 'CREATING', { actorId, message: null });

    let externalId: string;
    let executionHost: string | null = null;

    try {
      const handle = await this.provider.create({
        workloadId: creating.id,
        kind: 'runtime',
        projectId: creating.projectId,
        image: creating.image,
        limits: {
          cpuMillicores: creating.cpuMillicores,
          memoryMb: creating.memoryMb,
          pidsLimit: creating.pidsLimit,
        },
        /*
         * The project's own configuration, and nothing else.
         *
         * Its plain variables and its secrets, merged here and handed
         * straight to the provider. Platform configuration, database
         * credentials and session keys are not in scope at this point and
         * cannot arrive by accident.
         *
         * Secrets are applied second. A name cannot be both, because setting
         * the second is refused whichever order they are set in, so this order
         * decides nothing: it is a backstop, and if the rule above were ever
         * broken the credential would win rather than a stale plain value.
         */
        env: await this.environmentFor(creating.projectId),
      });
      externalId = handle.externalId;
      executionHost = handle.host ?? null;
    } catch (error) {
      await this.fail(
        creating,
        error,
        actorId,
        'The development environment could not be created.',
      );
      throw this.userFacing(error, 'The development environment could not be created.');
    }

    /*
     * Recorded immediately. A workload the database cannot name is a workload
     * nobody will ever clean up, and everything below here can still fail.
     *
     * The host is written down beside the identifier that also encodes it,
     * because this column is what the scheduler counts: working out what is on
     * each machine by parsing an opaque identifier would make that encoding
     * something the whole platform depended on. Both come from the one moment
     * the placement was decided, so they cannot disagree.
     */
    await this.runtimes.attachExternalId(creating.id, externalId, executionHost);

    try {
      // The database is the source of truth for a project's source, so the
      // workload begins as a copy of it rather than as its own store. Done
      // before the container starts, so nothing inside it ever observes a
      // half-populated workspace.
      const entries = await this.files.exportAll(creating.projectId);
      await this.provider.seedWorkspace({ externalId }, entries);
    } catch (error) {
      await this.fail(creating, error, actorId, 'The project files could not be copied in.');
      throw this.userFacing(error, 'The project files could not be copied in.');
    }

    const starting = await this.move(creating, 'STARTING', { actorId, message: null, externalId });

    try {
      await this.provider.start({ externalId });
    } catch (error) {
      await this.fail(
        starting,
        error,
        actorId,
        'The development environment could not be started.',
      );
      throw this.userFacing(error, 'The development environment could not be started.');
    }

    await this.move(starting, 'RUNNING', { actorId, message: null, startedAt: new Date() });
  }

  /**
   * Prepares an existing stopped or failed runtime to be started again.
   *
   * The spec is rewritten first: a project that was Python last week and is
   * Node today must not be restarted on the image it used last time.
   */
  private async reuse(
    existing: RuntimeRecord,
    spec: RuntimeDetection,
    actorId: string,
  ): Promise<RuntimeRecord> {
    await this.runtimes.updateSpec(existing.id, {
      provider: this.provider.name,
      language: spec.language,
      version: spec.version,
      image: spec.image,
      cpuMillicores: this.options.limits.cpuMillicores,
      memoryMb: this.options.limits.memoryMb,
      pidsLimit: this.options.limits.pidsLimit,
    });

    return this.move(existing, 'REQUESTED', { actorId, message: null, externalId: null });
  }

  /** The runtime this project should run, from an override or from its files. */
  private async resolveSpec(
    projectId: string,
    override?: RuntimeLanguage,
  ): Promise<RuntimeDetection> {
    if (override) {
      const definition = RUNTIME_DEFINITIONS[override];
      return {
        language: definition.language,
        version: definition.version,
        image: definition.image,
        evidence: 'chosen explicitly',
      };
    }

    const detected = await this.detect(projectId);
    if (detected) return detected;

    throw new AppError(
      'PRECONDITION_FAILED',
      'This project does not say which runtime it needs. Add a manifest such as package.json or requirements.txt, or choose a language.',
    );
  }

  private async requireProvider(): Promise<void> {
    const reason = await this.provider.unavailableReason();
    if (reason) throw new AppError('RUNTIME_UNAVAILABLE', reason, { expose: true });
  }

  /**
   * Applies one transition, refusing an illegal one and detecting a race.
   *
   * The shared table is consulted first, so a transition this code has no
   * business making fails as a programming error rather than being written.
   */
  private async move(
    record: RuntimeRecord,
    to: RuntimeStatus,
    options: {
      actorId: string | null;
      message: string | null;
      externalId?: string | null;
      startedAt?: Date;
      stoppedAt?: Date;
      reason?: string;
    },
  ): Promise<RuntimeRecord> {
    if (!canTransition(RUNTIME_TRANSITIONS, record.status, to)) {
      throw new Error(`Illegal runtime transition ${record.status} -> ${to}`);
    }

    const next = await this.runtimes.transition({
      runtimeId: record.id,
      from: record.status,
      expectedRevision: record.revision,
      to,
      message: options.message,
      actorId: options.actorId,
      ...(options.externalId === undefined ? {} : { externalId: options.externalId }),
      ...(options.startedAt === undefined ? {} : { startedAt: options.startedAt }),
      ...(options.stoppedAt === undefined ? {} : { stoppedAt: options.stoppedAt }),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });

    if (!next) {
      throw new AppError(
        'CONFLICT',
        'Someone else changed this runtime at the same time. Check its state and try again.',
      );
    }

    /*
     * Every runtime state change passes through here, so this is the one place
     * that has to announce one.
     *
     * After the transition is recorded, never before. A window told a container
     * is running before the row says so would ask about it and be told it is
     * not, which is worse than being told a moment late.
     */
    this.events?.publish(record.projectId, { type: 'runtime.changed', status: to });

    return next;
  }

  /**
   * Records a failure against the runtime.
   *
   * The stored message is written for a person. The provider's own error goes
   * to the log, where it can carry detail that must not reach a browser.
   */
  private async fail(
    record: RuntimeRecord,
    error: unknown,
    actorId: string,
    fallback: string,
  ): Promise<void> {
    const message = this.userFacing(error, fallback).message;

    this.log.error(
      { err: error, runtimeId: record.id, projectId: record.projectId, status: record.status },
      'Runtime operation failed',
    );

    await this.discardWorkload(record.id);

    try {
      await this.move(record, 'FAILED', { actorId, message: message.slice(0, 500) });
    } catch (recordingError) {
      // The original failure is what matters and is already being thrown. This
      // one is logged so a runtime stuck mid-transition is discoverable.
      this.log.error({ err: recordingError, runtimeId: record.id }, 'Could not record the failure');
    }
  }

  /**
   * The error to show the caller.
   *
   * A provider's refusal is already written for a person, so it is passed
   * through. Anything else becomes a generic execution failure, because an
   * unexpected error can carry host paths and internal addresses.
   */
  private userFacing(error: unknown, fallback: string): AppError {
    if (error instanceof AppError && error.expose) return error;
    return new AppError('EXECUTION_FAILED', fallback, { expose: true, cause: error });
  }

  /**
   * Removes a workload that will not be used.
   *
   * A failed start can leave a container created but never run. Left alone it
   * holds its name and its share of the host for ever, and the next start
   * would find the name taken. A failure to clean up is logged rather than
   * thrown: the original failure is what the caller needs to hear about.
   */
  private async discardWorkload(runtimeId: string): Promise<void> {
    const current = await this.runtimes.findById(runtimeId);
    if (!current?.externalId) return;

    try {
      await this.provider.destroy({ externalId: current.externalId });
    } catch (error) {
      this.log.error({ err: error, runtimeId }, 'Could not remove the failed workload');
    }
  }

  private async reload(runtimeId: string): Promise<RuntimeRecord> {
    const record = await this.runtimes.findById(runtimeId);
    if (!record) throw new AppError('NOT_FOUND', 'Runtime not found');
    return record;
  }
}

/** Just the counts, for a log line that has to stay one line. */
function summarise(result: WorkspaceSyncResult) {
  return {
    created: result.created,
    updated: result.updated,
    deleted: result.deleted,
    unchanged: result.unchanged,
  };
}

function isInFlight(status: RuntimeStatus): boolean {
  return (
    status === 'REQUESTED' ||
    status === 'CREATING' ||
    status === 'STARTING' ||
    status === 'STOPPING'
  );
}

/**
 * The wire shape of a runtime row.
 *
 * The provider's own identifier is deliberately absent. A container id is
 * useful to an operator reading logs and useless to a browser, and publishing
 * it tells a caller about the shape of the execution plane.
 */
export function toSummary(record: RuntimeRecord): RuntimeSummary {
  if (!isRuntimeLanguage(record.language)) {
    throw new AppError(
      'INTERNAL_ERROR',
      'This runtime uses a language the platform no longer has',
      {
        context: { runtimeId: record.id, language: record.language },
      },
    );
  }

  return {
    id: record.id,
    projectId: record.projectId,
    status: record.status,
    language: record.language,
    version: record.version,
    image: record.image,
    limits: {
      cpuMillicores: record.cpuMillicores,
      memoryMb: record.memoryMb,
      pidsLimit: record.pidsLimit,
    },
    message: record.message,
    createdAt: record.createdAt.toISOString(),
    statusChangedAt: record.statusChangedAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    stoppedAt: record.stoppedAt?.toISOString() ?? null,
  };
}

function megabytes(bytes: number): string {
  return `${String(Math.round(bytes / (1024 * 1024)))} MB`;
}
