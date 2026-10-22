import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { createJobWorker } from '../src/jobs/job-worker.js';
import { InMemoryJobQueue } from '../src/jobs/memory-queue.js';
import { JobRepository } from '../src/modules/jobs/job.repository.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * Claiming work, against a real database.
 *
 * The claim is raw SQL with `FOR UPDATE SKIP LOCKED`, an ordering, and — when
 * a limit applies — an advisory lock. None of that can be believed from a
 * stub, so every case here is the real statement against PostgreSQL.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

const enqueue = (
  jobs: JobRepository,
  type: 'RUNTIME_START' | 'DEPLOYMENT_BUILD',
  priority = 0,
  scheduledAt?: Date,
) =>
  jobs.enqueue({
    projectId: null,
    type,
    payload: {},
    maxAttempts: 3,
    priority,
    ...(scheduledAt ? { scheduledAt } : {}),
  });

describe.skipIf(!db)('claiming jobs', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('takes the most urgent due job first, then the oldest', async () => {
    const jobs = new JobRepository(db! as never);
    const oldBuild = await enqueue(jobs, 'DEPLOYMENT_BUILD', 0, new Date(Date.now() - 60_000));
    const start = await enqueue(jobs, 'RUNTIME_START', 10);
    const newBuild = await enqueue(jobs, 'DEPLOYMENT_BUILD', 0);

    expect((await jobs.claim('w'))?.id).toBe(start.id);
    expect((await jobs.claim('w'))?.id).toBe(oldBuild.id);
    expect((await jobs.claim('w'))?.id).toBe(newBuild.id);
    expect(await jobs.claim('w')).toBeNull();
  });

  it('does not take work that is not due yet', async () => {
    const jobs = new JobRepository(db! as never);
    await enqueue(jobs, 'RUNTIME_START', 10, new Date(Date.now() + 60_000));
    expect(await jobs.claim('w')).toBeNull();
  });

  it('never gives one job to two workers', async () => {
    const jobs = new JobRepository(db! as never);
    for (let i = 0; i < 20; i++) await enqueue(jobs, 'DEPLOYMENT_BUILD');

    const claims = await Promise.all(
      Array.from({ length: 30 }, (_, i) => jobs.claim(`worker-${i}`)),
    );
    const ids = claims.filter((job) => job !== null).map((job) => job!.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it('holds a type at its limit and lets other types past it', async () => {
    const jobs = new JobRepository(db! as never, { concurrency: { DEPLOYMENT_BUILD: 2 } });
    for (let i = 0; i < 4; i++) await enqueue(jobs, 'DEPLOYMENT_BUILD');
    const start = await enqueue(jobs, 'RUNTIME_START', 0);

    const first = await jobs.claim('w');
    const second = await jobs.claim('w');
    expect([first?.type, second?.type].sort()).toEqual(['DEPLOYMENT_BUILD', 'DEPLOYMENT_BUILD']);

    // Two builds running: the third waits, and the environment goes ahead.
    expect((await jobs.claim('w'))?.id).toBe(start.id);
    expect(await jobs.claim('w')).toBeNull();

    // One finishes; one more may start.
    await jobs.markSucceeded(first!.id);
    expect((await jobs.claim('w'))?.type).toBe('DEPLOYMENT_BUILD');
    expect(await jobs.claim('w')).toBeNull();
  });

  it('keeps a limit under concurrent claimers', async () => {
    const jobs = new JobRepository(db! as never, { concurrency: { DEPLOYMENT_BUILD: 3 } });
    for (let i = 0; i < 12; i++) await enqueue(jobs, 'DEPLOYMENT_BUILD');

    const claims = await Promise.all(
      Array.from({ length: 12 }, (_, i) => jobs.claim(`worker-${i}`)),
    );
    expect(claims.filter((job) => job !== null)).toHaveLength(3);
    expect(await db!.job.count({ where: { status: 'RUNNING' } })).toBe(3);
  });

  it('treats zero as no limit', async () => {
    const jobs = new JobRepository(db! as never, { concurrency: { DEPLOYMENT_BUILD: 0 } });
    for (let i = 0; i < 5; i++) await enqueue(jobs, 'DEPLOYMENT_BUILD');
    for (let i = 0; i < 5; i++) expect(await jobs.claim('w')).not.toBeNull();
  });

  it('gives back work whose worker went quiet, and fails it when out of attempts', async () => {
    const jobs = new JobRepository(db! as never);
    const job = await jobs.enqueue({
      projectId: null,
      type: 'RUNTIME_START',
      payload: {},
      maxAttempts: 1,
      priority: 0,
    });
    await jobs.claim('w');

    const { failed } = await jobs.reclaimStale(-1_000);
    expect(failed.map((row) => row.id)).toEqual([job.id]);
    expect((await jobs.findById(job.id))?.status).toBe('FAILED');
  });

  async function maxInFlight(
    concurrency: number,
    jobCount: number,
    trickle = false,
  ): Promise<number> {
    const jobs = new JobRepository(db! as never);
    const queue = new InMemoryJobQueue();
    const add = async () => {
      await jobs.enqueue({
        projectId: null,
        type: 'RUNTIME_START',
        // A payload the worker accepts: it validates every job before running it.
        payload: {
          runtimeId: '018f0000-0000-7000-8000-000000000001',
          actorId: '018f0000-0000-7000-8000-000000000002',
        },
        maxAttempts: 1,
        priority: 0,
      });
      queue.publish();
    };
    if (!trickle) for (let i = 0; i < jobCount; i++) await add();

    let inFlight = 0;
    let peak = 0;
    let finished = 0;
    const worker = createJobWorker({
      jobs,
      queue,
      handlers: {
        RUNTIME_START: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 150));
          inFlight -= 1;
          finished += 1;
        },
      },
      options: {
        concurrency,
        pollIntervalMs: 200,
        retryBaseMs: 1_000,
        retryMaxMs: 1_000,
        jobTimeoutMs: 10_000,
        heartbeatMs: 1_000,
        staleAfterMs: 60_000,
        reapIntervalMs: 60_000,
      },
      log: pino({ level: 'silent' }),
    });
    worker.start();
    if (trickle) {
      // Work arriving one at a time into an idle worker, as a burst of
      // requests does: every lane must still get used.
      for (let i = 0; i < jobCount; i++) {
        await add();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await expect.poll(() => finished, { timeout: 10_000 }).toBe(jobCount);
    await worker.stop();
    return peak;
  }

  it('runs several jobs at once when told to, and each exactly once', async () => {
    expect(await maxInFlight(4, 8)).toBe(4);
    expect(await db!.job.count({ where: { status: 'SUCCEEDED' } })).toBe(8);
  });

  it('runs one at a time with a single lane', async () => {
    expect(await maxInFlight(1, 3)).toBe(1);
  });

  it('uses every lane when work trickles in, not only when it was all waiting', async () => {
    expect(await maxInFlight(4, 12, true)).toBe(4);
  });
});
