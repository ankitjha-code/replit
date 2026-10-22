import type { Logger } from 'pino';
import type { ExecutionProvider, ProviderState } from '../execution/provider.js';
import type { JobRepository } from '../modules/jobs/job.repository.js';
import type { DeploymentRepository } from '../modules/deployments/deployment.repository.js';
import type { RuntimeRepository } from '../modules/runtimes/runtime.repository.js';
import type { UserDatabaseProvider } from '../userdb/provider.js';
import type {
  RecoveryRepository,
  UnfinishedDeployment,
  UnfinishedRuntime,
} from './recovery.repository.js';

/**
 * Making the platform's records true again after it stops unexpectedly.
 *
 * Most of what this platform records is a claim about something a process was
 * carrying. `STARTING` means a process is starting a container. `BUILDING`
 * means a worker is building. `RUNNING` means a container exists and is up.
 * None of those claims survives the process that made them, and nothing before
 * this task ever checked them again:
 *
 *  - a runtime stuck in `STARTING` for ever, because the process that would
 *    have moved it to `RUNNING` was killed mid-deploy;
 *  - a project whose workspace says it is running, on a host that rebooted;
 *  - a database left `CREATING`, which no code path can ever move;
 *  - a deployment `BUILDING` with nothing building it.
 *
 * Every one of those is a person looking at a page that is lying to them, with
 * no way out but an operator editing rows.
 *
 * ## What recovery may and may not do
 *
 * It **asks** the execution plane what is true and writes that down. It does
 * not start anything, restart anything, or retry anything. Those are decisions,
 * and a process that made decisions on every boot would turn a crash loop into
 * a machine starting containers in a loop.
 *
 * The one exception is a runtime whose row says `STOPPING`: somebody asked for
 * it to stop, the request was interrupted, and finishing it is carrying out an
 * instruction that already exists rather than making a new one.
 *
 * ## It never guesses
 *
 * If the execution plane cannot be reached, recovery does **nothing** to
 * runtimes or deployments and says so. The alternative — treating "I could not
 * ask" as "it is not there" — would mark every running project on the
 * installation as failed the first time a socket was busy at boot. A stale row
 * is a bad state that fixes itself on the next successful boot. A wrongly
 * failed one is somebody's environment.
 *
 * ## Two instances booting together
 *
 * There is no lock, and that is not an oversight. Every write here goes through
 * the same optimistic transition every other caller uses: it names the status
 * and the revision it believes, and it changes nothing if either has moved. Two
 * instances recovering the same runtime means one wins and the other matches no
 * rows, which is already an outcome every transition in this codebase handles.
 */

export interface RecoveryOptions {
  /**
   * How long the whole pass may take before the process gives up waiting.
   *
   * Recovery runs before anything is served, which is what makes it useful and
   * also what makes it dangerous: an unreachable container runtime that accepts
   * a connection and never answers would keep the platform from starting at all.
   * A bound turns the worst case from "the platform is down" into "the platform
   * is up with some stale rows", which is the trade every other decision in this
   * file makes too.
   */
  timeoutMs: number;

  /**
   * How long a job may be held without a heartbeat before it is taken back.
   *
   * The same number the worker's own reaper uses. Recovery does not invent a
   * shorter one: a job held by a *different* worker that is perfectly alive
   * must not be taken away from it just because this process restarted.
   */
  jobStaleAfterMs: number;
}

export interface RecoveryReport {
  runtimes: { examined: number; corrected: number; skipped?: string };
  deployments: { examined: number; corrected: number; skipped?: string };
  databases: { examined: number; corrected: number; skipped?: string };
  jobs: { requeued: number; failed: number };
}

const RESTART_MESSAGE = 'The platform restarted while this was in progress.';

export class StartupRecovery {
  constructor(
    private readonly recovery: RecoveryRepository,
    private readonly runtimes: RuntimeRepository,
    private readonly deployments: DeploymentRepository,
    private readonly jobs: JobRepository,
    private readonly execution: ExecutionProvider,
    private readonly userDatabases: UserDatabaseProvider,
    private readonly options: RecoveryOptions,
    private readonly log: Logger,
  ) {}

  /**
   * One pass, at boot, before anything is served.
   *
   * Never throws. A platform that refuses to start because it could not
   * reconcile is worse than one that starts with stale rows: the stale rows are
   * visible and fixable, and a process that will not boot is neither.
   */
  async recover(): Promise<RecoveryReport> {
    /*
     * Raced, not cancelled.
     *
     * There is no way to unwind a half-finished pass, and there is no need: what
     * it has already written is correct, and what it writes after this point is
     * correct too. The race decides when the *process* stops waiting, not when
     * the work stops. Every write it makes is guarded by a status and a
     * revision, so one still in flight while requests are being served is in
     * exactly the position a second instance would be in.
     */
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<RecoveryReport>((resolve) => {
      timer = setTimeout(() => {
        this.log.warn(
          { timeoutMs: this.options.timeoutMs },
          'startup recovery is taking too long; carrying on without waiting for it',
        );
        resolve({
          runtimes: { examined: 0, corrected: 0, skipped: 'recovery did not finish in time' },
          deployments: { examined: 0, corrected: 0, skipped: 'recovery did not finish in time' },
          databases: { examined: 0, corrected: 0, skipped: 'recovery did not finish in time' },
          jobs: { requeued: 0, failed: 0 },
        });
      }, this.options.timeoutMs);
      timer.unref();
    });

    try {
      return await Promise.race([this.run(), bound]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async run(): Promise<RecoveryReport> {
    const report: RecoveryReport = {
      runtimes: { examined: 0, corrected: 0 },
      deployments: { examined: 0, corrected: 0 },
      databases: { examined: 0, corrected: 0 },
      jobs: { requeued: 0, failed: 0 },
    };

    /*
     * Asked once, for everything.
     *
     * Both the runtime and the deployment pass need the answer, and asking
     * twice would let them disagree: a backend that went away between the two
     * would have one pass correcting rows and the other refusing to.
     */
    const executionDown = await this.execution.unavailableReason().catch((error: unknown) => {
      return error instanceof Error ? error.message : 'The execution plane could not be reached.';
    });

    if (executionDown) {
      this.log.warn(
        { reason: executionDown },
        'the execution plane cannot be reached; runtimes and deployments were left as they are',
      );
      report.runtimes.skipped = executionDown;
      report.deployments.skipped = executionDown;
    } else {
      await this.recoverRuntimes(report);
      await this.recoverDeployments(report);
    }

    await this.recoverDatabases(report);
    await this.recoverJobs(report);

    this.log.info({ report }, 'startup recovery finished');
    return report;
  }

  private async recoverRuntimes(report: RecoveryReport): Promise<void> {
    let unfinished: UnfinishedRuntime[];

    try {
      unfinished = await this.recovery.listUnfinishedRuntimes();
    } catch (error) {
      report.runtimes.skipped = messageOf(error);
      this.log.error({ err: error }, 'unfinished runtimes could not be read');
      return;
    }

    report.runtimes.examined = unfinished.length;

    for (const runtime of unfinished) {
      try {
        if (await this.recoverRuntime(runtime)) report.runtimes.corrected += 1;
      } catch (error) {
        // One runtime that cannot be reconciled must not stop the rest. The row
        // stays as it was, which is the state recovery started from.
        this.log.error(
          { err: error, runtimeId: runtime.id, projectId: runtime.projectId },
          'a runtime could not be reconciled',
        );
      }
    }
  }

  /** True when something was written. */
  private async recoverRuntime(runtime: UnfinishedRuntime): Promise<boolean> {
    const state = await this.observe(runtime.externalId);

    /*
     * An instruction that was already given, carried out.
     *
     * Somebody asked for this to stop. The process that would have done it is
     * gone, and the container may well still be up. Finishing the stop is not a
     * decision recovery is making — it is the one that was already made.
     */
    if (runtime.status === 'STOPPING') {
      if (state === 'running' && runtime.externalId) {
        await this.execution
          .stop({ externalId: runtime.externalId }, 5)
          .catch((error: unknown) =>
            this.log.warn(
              { err: error, runtimeId: runtime.id },
              'an interrupted stop could not be completed; the row is being closed anyway',
            ),
          );
      }

      return this.moveRuntime(runtime, 'STOPPED', 'This environment was stopped as requested.');
    }

    if (state === 'running') {
      /*
       * It is up. The row simply never caught up.
       *
       * Walked forward through the legal states rather than jumped, so the
       * runtime's own event log reads as a history rather than as a teleport,
       * and so the transition table stays the only description of what moves
       * are allowed.
       */
      if (runtime.status === 'RUNNING') return this.reconcileRun(runtime);

      const path = pathTo('runtime', runtime.status, 'RUNNING');
      if (!path) return false;

      let current = runtime;
      for (const next of path) {
        const moved = await this.moveRuntime(
          current,
          next,
          next === 'RUNNING' ? null : RESTART_MESSAGE,
        );
        if (!moved) return false;
        current = {
          ...current,
          status: next as UnfinishedRuntime['status'],
          revision: current.revision + 1,
        };
      }

      await this.reconcileRun({ ...runtime, status: 'RUNNING' });
      return true;
    }

    /*
     * It is not up, and the row says something was carrying it.
     *
     * `RUNNING` becomes `STOPPED` rather than `FAILED`: nothing is known to
     * have gone wrong with the project itself, and `FAILED` is a state a person
     * has to clear. Anything mid-start becomes `FAILED`, because a start that
     * did not finish is a start that did not work, and saying so is what lets
     * somebody press the button again.
     */
    const target = runtime.status === 'RUNNING' ? 'STOPPED' : 'FAILED';
    const message =
      runtime.status === 'RUNNING'
        ? 'This environment was no longer running when the platform came back.'
        : RESTART_MESSAGE;

    const moved = await this.moveRuntime(runtime, target, message);
    if (moved) await this.closeRun(runtime, 'The environment it was running in is gone.');

    return moved;
  }

  /**
   * What the runtime's *program* is doing, once the container is known to be up.
   *
   * Separate from the runtime's own status because they are separate facts: a
   * container that is up with a dead program in it is a real and common state.
   *
   * **The output stream is not re-attached.** Whatever the program printed while
   * the platform was down is gone, and the console will show nothing until it is
   * run again. Reattaching to a process started by a process that no longer
   * exists is its own piece of work; what matters here is that the row stops
   * claiming a stream nobody is holding.
   */
  private async reconcileRun(runtime: UnfinishedRuntime): Promise<boolean> {
    if (runtime.runStatus !== 'RUNNING' && runtime.runStatus !== 'STARTING') return false;
    if (!runtime.externalId) return false;

    const running = await this.execution
      .processRunning({ externalId: runtime.externalId })
      .catch(() => false);

    if (running) {
      this.log.info(
        { runtimeId: runtime.id, projectId: runtime.projectId },
        "a project's program is still running, but its output is no longer being streamed",
      );
      return false;
    }

    await this.closeRun(runtime, 'This stopped while the platform was restarting.');
    return true;
  }

  private async closeRun(runtime: UnfinishedRuntime, message: string): Promise<void> {
    if (runtime.runStatus !== 'RUNNING' && runtime.runStatus !== 'STARTING') return;

    await this.runtimes.setRunState(runtime.id, {
      runStatus: 'FAILED',
      runExitedAt: new Date(),
      // Deliberately null. An exit code is what a program returned, and nothing
      // here observed one; zero would read as a clean exit that never happened.
      runExitCode: null,
      runMessage: message,
      previewPort: null,
    });
  }

  private async moveRuntime(
    runtime: UnfinishedRuntime,
    to: string,
    message: string | null,
  ): Promise<boolean> {
    const moved = await this.runtimes.transition({
      runtimeId: runtime.id,
      from: runtime.status,
      expectedRevision: runtime.revision,
      to: to as UnfinishedRuntime['status'],
      message,
      reason: 'platform restart',
      ...(to === 'STOPPED' || to === 'FAILED' ? { stoppedAt: new Date() } : {}),
    });

    if (!moved) {
      // Somebody else got there first, which on a boot means another instance
      // recovering the same row. Nothing to do and nothing wrong.
      this.log.debug({ runtimeId: runtime.id }, 'a runtime moved before recovery reached it');
      return false;
    }

    this.log.info(
      { runtimeId: runtime.id, projectId: runtime.projectId, from: runtime.status, to },
      'a runtime record was corrected after a restart',
    );
    return true;
  }

  private async recoverDeployments(report: RecoveryReport): Promise<void> {
    let unfinished: UnfinishedDeployment[];

    try {
      unfinished = await this.recovery.listUnfinishedDeployments();
    } catch (error) {
      report.deployments.skipped = messageOf(error);
      this.log.error({ err: error }, 'unfinished deployments could not be read');
      return;
    }

    report.deployments.examined = unfinished.length;
    if (unfinished.length === 0) return;

    /*
     * Work the queue still intends to do is not work that was interrupted.
     *
     * A deployment `BUILDING` with a job still queued for it will be built when
     * a worker picks the job up. Failing it here would throw away work the
     * platform is about to do, and the person would see a failure for something
     * that then succeeded.
     */
    const outstanding = await this.outstandingDeploymentIds();

    for (const deployment of unfinished) {
      try {
        if (outstanding.has(deployment.id)) continue;
        if (await this.recoverDeployment(deployment)) report.deployments.corrected += 1;
      } catch (error) {
        this.log.error(
          { err: error, deploymentId: deployment.id, projectId: deployment.projectId },
          'a deployment could not be reconciled',
        );
      }
    }
  }

  private async recoverDeployment(deployment: UnfinishedDeployment): Promise<boolean> {
    const state = await this.observe(deployment.externalId);

    if (deployment.status === 'STOPPING') {
      return this.moveDeployment(
        deployment,
        'STOPPED',
        'This deployment was stopped as requested.',
      );
    }

    if (state === 'running') {
      if (deployment.status === 'RUNNING') return false;

      const path = pathTo('deployment', deployment.status, 'RUNNING');
      if (!path) return false;

      let current = deployment;
      for (const next of path) {
        const moved = await this.moveDeployment(
          current,
          next,
          next === 'RUNNING' ? null : RESTART_MESSAGE,
        );
        if (!moved) return false;
        current = {
          ...current,
          status: next as UnfinishedDeployment['status'],
          revision: current.revision + 1,
        };
      }

      return true;
    }

    /*
     * A deployment that is not running is a failure, including one whose row
     * said `RUNNING`.
     *
     * This is where deployments and runtimes part company. A development
     * environment that is down is merely stopped, and somebody will start it
     * when they next sit down. A deployment that is down is a site that is off,
     * and calling that "stopped" would hide an outage behind a word that sounds
     * deliberate.
     */
    const message =
      deployment.status === 'RUNNING'
        ? 'This deployment was no longer running when the platform came back.'
        : RESTART_MESSAGE;

    return this.moveDeployment(deployment, 'FAILED', message);
  }

  private async moveDeployment(
    deployment: UnfinishedDeployment,
    to: string,
    message: string | null,
  ): Promise<boolean> {
    const moved = await this.deployments.transition({
      deploymentId: deployment.id,
      from: deployment.status,
      expectedRevision: deployment.revision,
      to: to as UnfinishedDeployment['status'],
      actorId: null,
      message,
      reason: 'platform restart',
      ...(to === 'STOPPED' || to === 'FAILED' ? { stoppedAt: new Date() } : {}),
    });

    if (!moved) return false;

    this.log.info(
      {
        deploymentId: deployment.id,
        projectId: deployment.projectId,
        from: deployment.status,
        to,
      },
      'a deployment record was corrected after a restart',
    );
    return true;
  }

  private async outstandingDeploymentIds(): Promise<Set<string>> {
    const jobs = await this.recovery.listOutstandingJobs().catch((error: unknown) => {
      this.log.error({ err: error }, 'outstanding jobs could not be read');
      /*
       * An empty set is the dangerous answer here, so it is not used.
       *
       * With no job list, every interrupted build looks abandoned and would be
       * failed — including ones a worker is about to run. Throwing puts the
       * whole deployment pass into its caller's error handler, which leaves the
       * rows alone.
       */
      throw error;
    });

    const ids = new Set<string>();

    for (const job of jobs) {
      if (job.type !== 'DEPLOYMENT_BUILD') continue;
      const id = (job.payload as { deploymentId?: unknown }).deploymentId;
      if (typeof id === 'string') ids.add(id);
    }

    return ids;
  }

  /**
   * Databases whose creation was interrupted.
   *
   * The row is written before the statements run, so `CREATING` means one of
   * two things and the server is the only place that knows which: the database
   * exists, in which case provisioning got far enough and the credentials in
   * the row are the right ones; or it does not, in which case nothing was made.
   *
   * Nothing is created here. A database that was half made is dropped and
   * recreated by the reset path, which is a person's decision, not a boot's.
   */
  private async recoverDatabases(report: RecoveryReport): Promise<void> {
    let provisioning: Awaited<ReturnType<RecoveryRepository['listProvisioningDatabases']>>;

    try {
      provisioning = await this.recovery.listProvisioningDatabases();
    } catch (error) {
      report.databases.skipped = messageOf(error);
      return;
    }

    report.databases.examined = provisioning.length;
    if (provisioning.length === 0) return;

    const unavailable = await this.userDatabases.unavailableReason().catch(() => 'unreachable');
    if (unavailable) {
      report.databases.skipped = unavailable;
      this.log.warn(
        { reason: unavailable },
        'the project database server cannot be reached; half-made databases were left as they are',
      );
      return;
    }

    const existing = new Set((await this.userDatabases.list()).map((entry) => entry.name));

    for (const database of provisioning) {
      try {
        if (existing.has(database.name)) {
          await this.recovery.markDatabaseReady(database.id);
        } else {
          await this.recovery.markDatabaseFailed(
            database.id,
            'Creating this database was interrupted by a platform restart. Try again.',
          );
        }

        report.databases.corrected += 1;
        this.log.info(
          { projectId: database.projectId, ready: existing.has(database.name) },
          'a half-made project database was resolved',
        );
      } catch (error) {
        this.log.error(
          { err: error, projectId: database.projectId },
          'a half-made project database could not be resolved',
        );
      }
    }
  }

  /**
   * Work a worker was holding when it died.
   *
   * The worker already reaps these on a timer. Running one pass at boot is not
   * a second mechanism, it is the first one not waiting: a restart is the moment
   * a whole process's worth of claims most likely went stale, and the natural
   * thing for somebody watching is for that to be true when the platform comes
   * back rather than a reap interval later.
   *
   * The same staleness threshold, deliberately. A shorter one would take work
   * away from a different worker that is perfectly alive.
   */
  private async recoverJobs(report: RecoveryReport): Promise<void> {
    try {
      const { requeued, failed } = await this.jobs.reclaimStale(this.options.jobStaleAfterMs);

      report.jobs = { requeued: requeued.length, failed: failed.length };

      if (requeued.length > 0 || failed.length > 0) {
        this.log.info(
          { requeued: requeued.length, failed: failed.length },
          'work held by a worker that is gone was taken back',
        );
      }
    } catch (error) {
      this.log.error({ err: error }, 'stale work could not be taken back');
    }
  }

  /**
   * What the execution plane says about one workload.
   *
   * A row with no identifier has nothing to ask about: the workload was never
   * created, which is `absent`. A question that fails is `absent` too, and that
   * is the one place recovery is generous — but only per workload, and only
   * after the plane as a whole answered that it is reachable.
   */
  private async observe(externalId: string | null): Promise<ProviderState> {
    if (!externalId) return 'absent';

    return this.execution.inspect({ externalId }).catch((error: unknown) => {
      this.log.warn({ err: error, externalId }, 'a workload could not be inspected');
      return 'absent' as ProviderState;
    });
  }
}

/**
 * The legal steps from one status to another.
 *
 * Each machine is a straight line forward, so a walk is just the statuses in
 * between. Written out rather than derived from the transition table, because
 * deriving it would mean a path search, and a path search over a lifecycle is a
 * way to discover moves nobody intended to allow.
 *
 * The two lines differ by one station — a runtime is created, a deployment is
 * built — which is exactly the kind of difference that a single shared line
 * with an exception in it would get wrong.
 */
const LINES = {
  runtime: ['REQUESTED', 'CREATING', 'STARTING', 'RUNNING'],
  deployment: ['REQUESTED', 'BUILDING', 'STARTING', 'RUNNING'],
} as const;

function pathTo(kind: keyof typeof LINES, from: string, to: string): string[] | null {
  const line = LINES[kind];
  const start = line.indexOf(from as never);
  const end = line.indexOf(to as never);

  // Backwards, sideways, or a status not on this line: not a walk this may make.
  if (start === -1 || end === -1 || end <= start) return null;

  return [...line.slice(start + 1, end + 1)];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The step failed for an unrecorded reason.';
}
