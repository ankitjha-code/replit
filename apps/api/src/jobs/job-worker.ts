import { randomUUID } from 'node:crypto';
import { jobPayloadSchemas, type JobType } from '@platform/shared';
import type { Logger } from 'pino';
import type { JobRecord, JobRepository } from '../modules/jobs/job.repository.js';
import type { JobQueue } from './queue.js';

/**
 * The thing that actually does the work.
 *
 * One loop: claim a job, run its handler, record what happened, go round again.
 * It runs inside the control plane by default and can be started as its own
 * process instead, and neither knows about the other — both claim from the same
 * table, and the claim is what stops two workers doing one job.
 *
 * ## Why it polls as well as listening
 *
 * The nudge is advice. A worker that missed one — because the queue was
 * unreachable, because it started after the enqueue, because the nudge came
 * from a process it cannot hear — still finds the work on its next poll. That is
 * what makes losing the queue a latency problem instead of a correctness one,
 * and it is the reason the poll interval is a normal number of seconds rather
 * than an apologetic one.
 *
 * ## Attempts are counted on the claim, not on the failure
 *
 * A job that reliably kills its worker never reaches a failure handler. Counting
 * only clean failures would let such a job be retried for ever, taking a worker
 * with it each time. The count going up as soon as work is taken is what bounds
 * that.
 */

export type JobHandler = (payload: unknown) => Promise<void>;

export interface JobWorkerOptions {
  /**
   * How many jobs this worker runs at once. One was the original design, and a
   * load test showed its cost: 100 environments started together, the last one
   * waited 33 seconds behind the other 99. Several lanes claim from the same
   * table, which is already safe for many workers.
   */
  concurrency?: number;
  /** How often to look for work regardless of nudges. */
  pollIntervalMs: number;
  /** The first retry delay. Each further attempt doubles it, to a ceiling. */
  retryBaseMs: number;
  retryMaxMs: number;
  /** How long a job may run before the worker stops waiting for it. */
  jobTimeoutMs: number;

  /**
   * How often a running job is touched to say the worker is still here.
   *
   * Comfortably shorter than the staleness threshold below, because one missed
   * heartbeat — a slow query, a moment of load — must not be enough to have the
   * work taken away from a worker that is still doing it.
   */
  heartbeatMs: number;

  /**
   * How long a job may go untouched before it is assumed abandoned.
   *
   * The one number that decides how quickly a killed worker's work comes back,
   * and how tolerant the platform is of a worker that is merely slow to report.
   * Several heartbeats' worth.
   */
  staleAfterMs: number;

  /** How often to look for work whose worker stopped saying it was there. */
  reapIntervalMs: number;
}

/**
 * Told when a job is given up on for good.
 *
 * The job table knows a job failed; it does not know that a runtime is now stuck
 * in REQUESTED because of it. This is how the thing that does know finds out.
 *
 * Called for both ways a job can be abandoned: a handler that failed its last
 * attempt, and a job whose worker died with none left.
 */
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
  /** Finishes the job in hand, if any, then stops. */
  stop(): Promise<void>;
}

export function createJobWorker(options: {
  jobs: JobRepository;
  queue: JobQueue;
  handlers: Partial<Record<JobType, JobHandler>>;
  /** Told when a job is given up on, so whatever was waiting for it can stop. */
  onExhausted?: JobExhaustedListener;
  options: JobWorkerOptions;
  log: Logger;
}): JobWorker {
  /*
   * A name for this worker, for the row it claims.
   *
   * Random rather than derived from the host or the process id: two workers on
   * one machine would otherwise share a name, and the whole value of recording
   * who holds a job is being able to tell them apart.
   */
  const workerId = `worker-${randomUUID().slice(0, 8)}`;

  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reaper: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  /**
   * The lanes currently taking work, kept so stopping can wait for the jobs in
   * hand rather than abandoning them half done.
   */
  const lanes = new Set<Promise<void>>();
  const maxLanes = Math.max(1, options.options.concurrency ?? 1);

  /*
   * Every nudge tops the lanes back up to the limit.
   *
   * A lane stops as soon as it finds the queue empty, which at the start of a
   * burst — while requests are still arriving — is most of them. Starting new
   * lanes only when none was running left a burst to one lane: 100 environments
   * started together finished 29 seconds later instead of about 14.
   */
  const wake = (): void => {
    if (!running) return;
    while (lanes.size < maxLanes) {
      const current: Promise<void> = lane().finally(() => {
        lanes.delete(current);
      });
      lanes.add(current);
    }
  };

  /** One line of work: keeps taking jobs while there are any. */
  async function lane(): Promise<void> {
    try {
      // A worker that took one job per nudge would fall behind a burst and
      // never catch up.
      for (;;) {
        if (!running) return;

        const job = await options.jobs.claim(workerId);
        if (!job) return;

        await run(job);
      }
    } catch (error) {
      // Claiming failed, which usually means the database is unreachable. The
      // poll below will try again; there is nothing useful to do here.
      options.log.error({ err: error, workerId }, 'a worker could not claim work');
    }
  }

  async function run(job: JobRecord): Promise<void> {
    const handler = options.handlers[job.type];

    if (!handler) {
      /*
       * A type nobody implements.
       *
       * Failed outright rather than retried: no number of attempts will produce
       * a handler, and leaving it queued would have the worker pick it up for
       * ever. This happens when a job outlives the version of the platform that
       * understood it, which is exactly when a clear failure is worth having.
       */
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
      // Also not retryable: the payload will not become valid by being read
      // again. Checked here as well as on the way in, because the two ends can
      // be different versions of this platform.
      await options.jobs.markFailed(job.id, {
        error: 'This work was recorded in a form this platform no longer understands.',
        retryAt: null,
      });
      options.log.error({ jobId: job.id, type: job.type }, 'a job payload did not parse');
      return;
    }

    const started = Date.now();

    /*
     * Says this worker is still here, for as long as the job runs.
     *
     * An image pull or a dependency install can take minutes, and without this
     * a long job is indistinguishable from a worker that died the instant it
     * claimed one — the reaper would take the work away from something still
     * doing it, and two containers would end up being built for one deployment.
     */
    const heartbeat = setInterval(() => {
      void options.jobs.touch(job.id, workerId).catch((error: unknown) => {
        // Not fatal. A missed heartbeat costs tolerance, not correctness, and
        // the staleness threshold is several heartbeats wide for this reason.
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
          // The job stays RUNNING in the table with nothing holding it. There is
          // no way to fix that from here, and a later task reclaims such rows.
          options.log.error({ err: failure, jobId: job.id }, 'a job failure could not be recorded');
        });

      options.log[attemptsLeft ? 'warn' : 'error'](
        { err: error, jobId: job.id, type: job.type, attempt: job.attempts },
        attemptsLeft ? 'job failed and will be tried again' : 'job failed for the last time',
      );

      /*
       * Whatever was waiting for this is told it is not coming.
       *
       * Only on the last attempt. A runtime left in REQUESTED because its work
       * failed is not the job table's problem to fix, and nothing else is
       * watching: without this the row sits there looking like it is about to
       * start, for ever.
       */
      if (!attemptsLeft) await announceExhausted(job, describe(error));
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Tells whoever cares that a job is not going to happen. */
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

  /**
   * Gives back work whose worker stopped saying it was there.
   *
   * The one thing standing between a worker being killed and a job sitting in
   * RUNNING for ever. Runs in every worker rather than in one elected reaper:
   * the reclaim is conditional on the job still being stale, so two reapers
   * racing is harmless, and an elected one would be a single point of failure
   * for the mechanism whose whole job is surviving one.
   */
  async function reap(): Promise<void> {
    if (!running) return;

    try {
      const { requeued, failed } = await options.jobs.reclaimStale(options.options.staleAfterMs);

      if (requeued.length > 0) {
        options.log.warn(
          { count: requeued.length },
          'work whose worker stopped was given back to the queue',
        );
        // Somebody should pick it up now rather than on their next poll.
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

  /**
   * How long to wait before trying again, doubling each time.
   *
   * A job that failed because something else was briefly unavailable succeeds on
   * the next attempt; one that failed because it is broken fails again
   * immediately. Backing off costs the first almost nothing and stops the second
   * from occupying a worker in a tight loop.
   */
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

        // A poll must not hold the process open at shutdown.
        timer.unref?.();
      };

      poll();

      /*
       * The reaper runs on its own interval, not with the poll.
       *
       * Looking for abandoned work is a different question from looking for new
       * work, asked far less often, and a worker busy with a long job must still
       * be asking it — otherwise a platform with one busy worker is a platform
       * with no recovery.
       */
      reaper = setInterval(() => void reap(), options.options.reapIntervalMs);
      reaper.unref?.();

      // Something may already be waiting from before this process started,
      // including work a worker that died was holding.
      wake();
      void reap();

      options.log.info({ workerId }, 'job worker started');
    },

    async stop() {
      running = false;
      unsubscribe?.();
      if (timer) clearTimeout(timer);
      if (reaper) clearInterval(reaper);

      /*
       * Waits for the job in hand.
       *
       * Stopping mid-job would leave the row RUNNING with nobody holding it,
       * which is the state a restart cannot tell from a crash. Finishing the one
       * in hand costs a moment at shutdown and avoids inventing that state on
       * every ordinary restart.
       */
      await Promise.all([...lanes]);
      options.log.info({ workerId }, 'job worker stopped');
    },
  };
}

/**
 * Fails a job that runs too long, rather than waiting for ever.
 *
 * The handler is not stopped, because nothing here can stop it: what ends is the
 * worker's willingness to wait. Said plainly because it matters — a timed-out
 * build may still be running in a container somewhere, and the retry that
 * follows will start a second one.
 */
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

/** A failure in words safe to store and show. */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : 'The work could not be completed.';
  // The column is bounded, and a message longer than this is a stack trace that
  // belongs in the log rather than on a page.
  return message.slice(0, 1000);
}
