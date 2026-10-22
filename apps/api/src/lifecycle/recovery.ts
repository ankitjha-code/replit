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

export interface RecoveryOptions {
  timeoutMs: number;

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

  async recover(): Promise<RecoveryReport> {
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
        this.log.error(
          { err: error, runtimeId: runtime.id, projectId: runtime.projectId },
          'a runtime could not be reconciled',
        );
      }
    }
  }

  private async recoverRuntime(runtime: UnfinishedRuntime): Promise<boolean> {
    const state = await this.observe(runtime.externalId);

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

    const target = runtime.status === 'RUNNING' ? 'STOPPED' : 'FAILED';
    const message =
      runtime.status === 'RUNNING'
        ? 'This environment was no longer running when the platform came back.'
        : RESTART_MESSAGE;

    const moved = await this.moveRuntime(runtime, target, message);
    if (moved) await this.closeRun(runtime, 'The environment it was running in is gone.');

    return moved;
  }

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

  private async observe(externalId: string | null): Promise<ProviderState> {
    if (!externalId) return 'absent';

    return this.execution.inspect({ externalId }).catch((error: unknown) => {
      this.log.warn({ err: error, externalId }, 'a workload could not be inspected');
      return 'absent' as ProviderState;
    });
  }
}

const LINES = {
  runtime: ['REQUESTED', 'CREATING', 'STARTING', 'RUNNING'],
  deployment: ['REQUESTED', 'BUILDING', 'STARTING', 'RUNNING'],
} as const;

function pathTo(kind: keyof typeof LINES, from: string, to: string): string[] | null {
  const line = LINES[kind];
  const start = line.indexOf(from as never);
  const end = line.indexOf(to as never);

  if (start === -1 || end === -1 || end <= start) return null;

  return [...line.slice(start + 1, end + 1)];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The step failed for an unrecorded reason.';
}
