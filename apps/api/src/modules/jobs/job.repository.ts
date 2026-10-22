import type { JobStatus, JobType } from '@platform/shared';
import type { Database } from '../../db/client.js';

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
  priority: number;
  scheduledAt?: Date;
}

interface ClaimedRow {
  id: string;
}

export interface JobRepositoryOptions {
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

  async claim(workerId: string): Promise<JobRecord | null> {
    const limits = Object.entries(this.options.concurrency ?? {}).filter(
      (entry): entry is [JobType, number] => typeof entry[1] === 'number' && entry[1] > 0,
    );

    const claimed =
      limits.length === 0
        ? await this.claimAmong(this.db, workerId, [])
        : await this.db.$transaction(async (tx) => {
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

  async touch(id: string, workerId: string): Promise<void> {
    await this.db.job.updateMany({
      where: { id, status: 'RUNNING', lockedBy: workerId },
      data: { lockedAt: new Date() },
    });
  }

  async reclaimStale(
    staleAfterMs: number,
  ): Promise<{ requeued: JobRecord[]; failed: JobRecord[] }> {
    const [clock] = await this.db.$queryRaw<{ now: Date }[]>`SELECT NOW() AS now`;
    const staleBefore = new Date((clock?.now ?? new Date()).getTime() - staleAfterMs);
    const stale = await this.db.job.findMany({
      where: { status: 'RUNNING', lockedAt: { lt: staleBefore } },
      select: FIELDS,
    });

    if (stale.length === 0) return { requeued: [], failed: [] };

    const requeue = stale.filter((job) => job.attempts < job.maxAttempts);
    const giveUp = stale.filter((job) => job.attempts >= job.maxAttempts);

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

  async hasDueWork(): Promise<boolean> {
    const found = await this.db.job.findFirst({
      where: { status: 'QUEUED', scheduledAt: { lte: new Date() } },
      select: { id: true },
    });
    return found !== null;
  }

  async cancel(id: string): Promise<boolean> {
    const { count } = await this.db.job.updateMany({
      where: { id, status: 'QUEUED' },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
    return count > 0;
  }

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
