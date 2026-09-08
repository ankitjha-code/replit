import type { JobStatus, JobType } from '@platform/shared';
import type { Database } from '../../db/client.js';

/**
 * The only code that reads or writes the jobs table.
 *
 * One query here is unlike anything else in the codebase and is the reason this
 * file exists rather than a few Prisma calls scattered about: claiming a job has
 * to be atomic across every worker, and the primitive that makes it atomic is
 * `FOR UPDATE SKIP LOCKED`, which has no expression in the query builder.
 *
 * Written as raw SQL for that reason and for that query only. Everything else
 * here goes through the same client the rest of the platform uses.
 */

export interface JobRecord {
  id: string;
  projectId: string | null;
  type: JobType;
  status: JobStatus;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  scheduledAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

const FIELDS = {
  id: true,
  projectId: true,
  type: true,
  status: true,
  payload: true,
  attempts: true,
  maxAttempts: true,
  lastError: true,
  scheduledAt: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
} as const;

export interface EnqueueJobInput {
  projectId: string | null;
  type: JobType;
  payload: object;
  maxAttempts: number;
  /** Higher goes first among due work. */
  priority: number;
  /** When it is first due. Now, unless something wants it later. */
  scheduledAt?: Date;
}

/** The shape the raw claim returns, before it is narrowed. */
interface ClaimedRow {
  id: string;
}

export interface JobRepositoryOptions {
  /**
   * How many jobs of a type may run at once across the whole installation.
   *
   * Missing or zero means no limit. Counted over every worker process, because
   * the reason to have a limit — builds saturating the execution hosts — is
   * about the installation, not about one process.
   */
  concurrency?: Partial<Record<JobType, number>>;
}

export class JobRepository {
  constructor(
    private readonly db: Database,
    private readonly options: JobRepositoryOptions = {},
  ) {}

  async enqueue(input: EnqueueJobInput): Promise<JobRecord> {
    return this.db.job.create({
      data: {
        projectId: input.projectId,
        type: input.type,
        payload: input.payload as never,
        maxAttempts: input.maxAttempts,
        priority: input.priority,
        ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
      },
      select: FIELDS,
    });
  }

  /**
   * Takes the next piece of work, or reports that there is none.
   *
   * The one query that genuinely needs raw SQL. Three things have to happen
   * indivisibly, and any gap between them is a job done twice:
   *
   *  - **Find** the most urgent job that is due: highest priority, then oldest.
   *  - **Skip** rows another worker is already holding, rather than waiting
   *    behind them. Without `SKIP LOCKED`, every worker queues up behind the
   *    same row and a pool of ten workers does the work of one.
   *  - **Mark** it running, in the same statement, so no other worker can see
   *    it as available.
   *
   * `attempts` is incremented here rather than on completion, deliberately. A
   * worker that dies mid-job has still used an attempt, and counting only
   * successes and clean failures would let a job that reliably kills its worker
   * be retried for ever.
   */
  async claim(workerId: string): Promise<JobRecord | null> {
    const limits = Object.entries(this.options.concurrency ?? {}).filter(
      (entry): entry is [JobType, number] => typeof entry[1] === 'number' && entry[1] > 0,
    );

    const claimed =
      limits.length === 0
        ? await this.claimAmong(this.db, workerId, [])
        : await this.db.$transaction(async (tx) => {
            /*
             * Claims are taken one at a time while a limit applies.
             *
             * Counting what is running and then claiming is two steps, and two
             * workers doing both at once would each see room for one more and
             * both take it. A transaction-scoped advisory lock makes the pair
             * indivisible; it is released when the transaction ends, so a worker
             * that dies cannot hold it. The cost is that claims no longer run in
             * parallel, which is milliseconds against jobs that take seconds.
             */
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('platform.jobs.claim'))`;

            const running = await tx.job.groupBy({
              by: ['type'],
              where: { status: 'RUNNING' },
              _count: { _all: true },
            });
            const counts = new Map(running.map((row) => [row.type, row._count._all]));
            const full = limits
              .filter(([type, limit]) => (counts.get(type) ?? 0) >= limit)
              .map(([type]) => type);

            return this.claimAmong(tx as unknown as Database, workerId, full);
          });

    if (!claimed) return null;
    return this.db.job.findUnique({ where: { id: claimed }, select: FIELDS });
  }

  /** The claim itself: the most urgent due job not of an excluded type. */
  private async claimAmong(
    db: Database,
    workerId: string,
    excluded: JobType[],
  ): Promise<string | null> {
    const rows = await db.$queryRaw<ClaimedRow[]>`
      UPDATE "jobs"
      SET
        "status" = 'RUNNING',
        "attempts" = "attempts" + 1,
        "startedAt" = NOW(),
        "lockedBy" = ${workerId},
        "lockedAt" = NOW(),
        "updatedAt" = NOW()
      WHERE "id" = (
        SELECT "id" FROM "jobs"
        WHERE "status" = 'QUEUED' AND "scheduledAt" <= NOW()
          AND NOT ("type"::text = ANY(${excluded}::text[]))
        ORDER BY "priority" DESC, "scheduledAt" ASC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING "id"
    `;
    return rows[0]?.id ?? null;
  }

  /**
   * Says this worker is still here and still working.
   *
   * Called while a job runs. Without it a long job — an image pull, a
   * dependency install — is indistinguishable from a worker that died the
   * moment it claimed one, and the reaper below would take the work away from
   * something that is still doing it.
   *
   * Conditional on this worker still holding the job. A worker whose job was
   * already reclaimed must not be able to touch it back to itself.
   */
  async touch(id: string, workerId: string): Promise<void> {
    await this.db.job.updateMany({
      where: { id, status: 'RUNNING', lockedBy: workerId },
      data: { lockedAt: new Date() },
    });
  }

  /**
   * Returns work whose worker stopped saying it was there.
   *
   * The counterpart to the heartbeat, and the one thing standing between a
   * worker being killed and a job sitting in RUNNING for ever. A job is stale
   * when nothing has touched it for longer than the platform allows, which can
   * only mean the worker holding it is gone: a live one heartbeats.
   *
   * Two outcomes, decided by the count that was already spent when the job was
   * claimed:
   *
   *  - **Attempts left**: back to QUEUED, due now. Something killed the worker;
   *    the work is still wanted.
   *  - **None left**: FAILED, with a reason saying what happened rather than
   *    leaving the last error from an earlier attempt to be misread as this one.
   *
   * Returns what it did, so a caller can tell whoever cares — a runtime stuck in
   * REQUESTED because its worker died is not the job table's problem to fix.
   */
  async reclaimStale(
    staleAfterMs: number,
  ): Promise<{ requeued: JobRecord[]; failed: JobRecord[] }> {
    /*
     * "Stale" by the database's clock, the same clock that stamped `lockedAt`.
     * A cutoff from this process's clock would be wrong by however far the two
     * machines' clocks disagree — enough, under load on Docker Desktop, to
     * reclaim nothing that should be, or to reclaim live work.
     */
    const [clock] = await this.db.$queryRaw<{ now: Date }[]>`SELECT NOW() AS now`;
    const staleBefore = new Date((clock?.now ?? new Date()).getTime() - staleAfterMs);
    const stale = await this.db.job.findMany({
      where: { status: 'RUNNING', lockedAt: { lt: staleBefore } },
      select: FIELDS,
    });

    if (stale.length === 0) return { requeued: [], failed: [] };

    const requeue = stale.filter((job) => job.attempts < job.maxAttempts);
    const giveUp = stale.filter((job) => job.attempts >= job.maxAttempts);

    /*
     * Both updates are conditional on the job still being RUNNING and still
     * stale.
     *
     * Two reapers can run at once — one in each worker process — and without the
     * condition the second would requeue a job the first had already given back,
     * spending a second attempt for nothing.
     */
    if (requeue.length > 0) {
      await this.db.job.updateMany({
        where: {
          id: { in: requeue.map((job) => job.id) },
          status: 'RUNNING',
          lockedAt: { lt: staleBefore },
        },
        data: {
          status: 'QUEUED',
          scheduledAt: new Date(),
          startedAt: null,
          lockedBy: null,
          lockedAt: null,
          lastError: 'The worker doing this stopped before it finished.',
        },
      });
    }

    if (giveUp.length > 0) {
      await this.db.job.updateMany({
        where: {
          id: { in: giveUp.map((job) => job.id) },
          status: 'RUNNING',
          lockedAt: { lt: staleBefore },
        },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          lockedBy: null,
          lockedAt: null,
          lastError: 'The worker doing this stopped, and there were no attempts left.',
        },
      });
    }

    return { requeued: requeue, failed: giveUp };
  }

  async markSucceeded(id: string): Promise<void> {
    await this.db.job.update({
      where: { id },
      data: {
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        lastError: null,
        lockedBy: null,
        lockedAt: null,
      },
    });
  }

  /**
   * Records a failed attempt: either due again later, or finished for good.
   *
   * One method rather than two, because the decision between them is the same
   * decision — whether any attempts remain — and splitting it would put that
   * rule in the caller where it could differ per call site.
   */
  async markFailed(id: string, input: { error: string; retryAt: Date | null }): Promise<void> {
    await this.db.job.update({
      where: { id },
      data: {
        status: input.retryAt ? 'QUEUED' : 'FAILED',
        lastError: input.error,
        lockedBy: null,
        lockedAt: null,
        ...(input.retryAt
          ? { scheduledAt: input.retryAt, startedAt: null }
          : { finishedAt: new Date() }),
      },
    });
  }

  findById(id: string): Promise<JobRecord | null> {
    return this.db.job.findUnique({ where: { id }, select: FIELDS });
  }

  listForProject(projectId: string, limit: number): Promise<JobRecord[]> {
    return this.db.job.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: FIELDS,
    });
  }

  /**
   * Whether anything is due now.
   *
   * Asked by a worker that has just been nudged, so it can go back to waiting
   * without taking a claim it does not need.
   */
  async hasDueWork(): Promise<boolean> {
    const found = await this.db.job.findFirst({
      where: { status: 'QUEUED', scheduledAt: { lte: new Date() } },
      select: { id: true },
    });
    return found !== null;
  }

  /**
   * Abandons a job nobody has run yet.
   *
   * Conditional on it still being queued: a job that has already been claimed is
   * running somewhere, and marking it cancelled would leave the platform
   * describing work that is still happening as work that never did. Returns
   * whether anything was actually cancelled.
   */
  async cancel(id: string): Promise<boolean> {
    const { count } = await this.db.job.updateMany({
      where: { id, status: 'QUEUED' },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
    return count > 0;
  }

  /** Removes settled jobs older than a cutoff, so the table does not grow for ever. */
  async prune(before: Date): Promise<number> {
    const { count } = await this.db.job.deleteMany({
      where: {
        status: { in: ['SUCCEEDED', 'CANCELLED'] },
        finishedAt: { lt: before },
      },
    });
    return count;
  }
}
