import { randomUUID } from 'node:crypto';
import { jobPayloadSchemas, type JobType } from '@platform/shared';
import type { Logger } from 'pino';
import type { JobRecord, JobRepository } from '../modules/jobs/job.repository.js';
import type { JobQueue } from './queue.js';

export type JobHandler = (payload: unknown) => Promise<void>;

export interface JobWorkerOptions {
  concurrency?: number;
  pollIntervalMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  jobTimeoutMs: number;

  heartbeatMs: number;

  staleAfterMs: number;

  reapIntervalMs: number;
}

export type JobExhaustedListener = (job: {
  id: string;
  type: JobType;
  payload: unknown;
  error: string;
}) => Promise<void>;

export interface JobWorker {
  readonly id: string;
  readonly running: boolean;
  start(): void;
  stop(): Promise<void>;
}

export function createJobWorker(options: {
  jobs: JobRepository;
  queue: JobQueue;
  handlers: Partial<Record<JobType, JobHandler>>;
  onExhausted?: JobExhaustedListener;
  options: JobWorkerOptions;
  log: Logger;
}): JobWorker {
  const workerId = `worker-${randomUUID().slice(0, 8)}`;

  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reaper: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const lanes = new Set<Promise<void>>();
  const maxLanes = Math.max(1, options.options.concurrency ?? 1);

  const wake = (): void => {
    if (!running) return;
    while (lanes.size < maxLanes) {
      const current: Promise<void> = lane().finally(() => {
        lanes.delete(current);
      });
      lanes.add(current);
    }
  };

  async function lane(): Promise<void> {
    try {
      for (;;) {
        if (!running) return;

        const job = await options.jobs.claim(workerId);
        if (!job) return;

        await run(job);
      }
    } catch (error) {
      options.log.error({ err: error, workerId }, 'a worker could not claim work');
    }
  }

  async function run(job: JobRecord): Promise<void> {
    const handler = options.handlers[job.type];

    if (!handler) {
      await options.jobs.markFailed(job.id, {
        error: `This platform has nothing that can do "${job.type}" work.`,
        retryAt: null,
      });
      options.log.error({ jobId: job.id, type: job.type }, 'no handler for a job type');
      return;
    }

    const schema = jobPayloadSchemas[job.type];
    const payload = schema.safeParse(job.payload);

    if (!payload.success) {
      await options.jobs.markFailed(job.id, {
        error: 'This work was recorded in a form this platform no longer understands.',
        retryAt: null,
      });
      options.log.error({ jobId: job.id, type: job.type }, 'a job payload did not parse');
      return;
    }

    const started = Date.now();

    const heartbeat = setInterval(() => {
      void options.jobs.touch(job.id, workerId).catch((error: unknown) => {
        options.log.debug({ err: error, jobId: job.id }, 'a job heartbeat failed');
      });
    }, options.options.heartbeatMs);
    heartbeat.unref?.();

    try {
      await withTimeout(handler(payload.data), options.options.jobTimeoutMs, job.type);

      await options.jobs.markSucceeded(job.id);
      options.log.info({ jobId: job.id, type: job.type, ms: Date.now() - started }, 'job finished');
    } catch (error) {
      const attemptsLeft = job.attempts < job.maxAttempts;
      const retryAt = attemptsLeft ? new Date(Date.now() + backoff(job.attempts)) : null;

      await options.jobs
        .markFailed(job.id, { error: describe(error), retryAt })
        .catch((failure: unknown) => {
          options.log.error({ err: failure, jobId: job.id }, 'a job failure could not be recorded');
        });

      options.log[attemptsLeft ? 'warn' : 'error'](
        { err: error, jobId: job.id, type: job.type, attempt: job.attempts },
        attemptsLeft ? 'job failed and will be tried again' : 'job failed for the last time',
      );

      if (!attemptsLeft) await announceExhausted(job, describe(error));
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function announceExhausted(job: JobRecord, error: string): Promise<void> {
    if (!options.onExhausted) return;

    try {
      await options.onExhausted({
        id: job.id,
        type: job.type,
        payload: job.payload,
        error,
      });
    } catch (failure) {
      options.log.error(
        { err: failure, jobId: job.id },
        'the thing waiting for a failed job could not be told',
      );
    }
  }

  async function reap(): Promise<void> {
    if (!running) return;

    try {
      const { requeued, failed } = await options.jobs.reclaimStale(options.options.staleAfterMs);

      if (requeued.length > 0) {
        options.log.warn(
          { count: requeued.length },
          'work whose worker stopped was given back to the queue',
        );
        options.queue.publish();
      }

      for (const job of failed) {
        options.log.error({ jobId: job.id, type: job.type }, 'work was abandoned for good');
        await announceExhausted(
          job,
          'The worker doing this stopped, and there were no attempts left.',
        );
      }
    } catch (error) {
      options.log.error({ err: error }, 'stale work could not be reclaimed');
    }
  }

  function backoff(attempt: number): number {
    return Math.min(
      options.options.retryBaseMs * 2 ** Math.max(attempt - 1, 0),
      options.options.retryMaxMs,
    );
  }

  return {
    id: workerId,

    get running() {
      return running;
    },

    start() {
      if (running) return;
      running = true;

      unsubscribe = options.queue.subscribe(wake);

      const poll = (): void => {
        timer = setTimeout(() => {
          wake();
          poll();
        }, options.options.pollIntervalMs);

        timer.unref?.();
      };

      poll();

      reaper = setInterval(() => void reap(), options.options.reapIntervalMs);
      reaper.unref?.();

      wake();
      void reap();

      options.log.info({ workerId }, 'job worker started');
    },

    async stop() {
      running = false;
      unsubscribe?.();
      if (timer) clearTimeout(timer);
      if (reaper) clearInterval(reaper);

      await Promise.all([...lanes]);
      options.log.info({ workerId }, 'job worker stopped');
    },
  };
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} took longer than this platform allows and was given up on.`));
    }, ms);

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : 'The work could not be completed.';
  return message.slice(0, 1000);
}
