import type { Logger } from 'pino';
import type { OrphanSweeper } from './orphan-sweeper.js';

/**
 * Running the sweep on a timer, in exactly one process.
 *
 * ## Why the worker and not the API
 *
 * A sweep talks to every machine the platform uses and deletes things. Running
 * it in the process that serves requests would put that beside a page load for
 * no benefit, and running it in *every* API instance would have several of them
 * enumerating and deleting the same containers at once.
 *
 * Two workers would race in the same way, and the race is survivable rather than
 * prevented: both would find the same orphan and both would try to remove it,
 * and removing something already gone succeeds everywhere in this codebase. What
 * is not survivable is deleting something young, which is why the grace period
 * and not a lock is the thing this design leans on.
 *
 * ## Why the first sweep is not at startup
 *
 * A platform that has just restarted has not yet reconciled its own rows with
 * what is running. Sweeping before that finishes would mean enumerating
 * containers whose rows are about to be corrected — so the first pass waits one
 * full interval, by which time recovery is long done.
 */

export interface SweepScheduleOptions {
  intervalMs: number;
  log: Logger;
}

export interface SweepSchedule {
  stop(): void;
}

export function startSweepSchedule(
  sweeper: OrphanSweeper,
  options: SweepScheduleOptions,
): SweepSchedule {
  let running = false;

  const tick = (): void => {
    /*
     * Never two at once.
     *
     * A sweep across a large installation can take longer than the interval, and
     * a second one starting on top of the first would be two passes deleting
     * from the same list. Skipping is right: the next tick is one interval away.
     */
    if (running) {
      options.log.warn('a cleanup sweep is still running; skipping this one');
      return;
    }

    running = true;
    void sweeper
      .sweep()
      .catch((error: unknown) => {
        // Already handled per step; this catches the unexpected. A cleanup
        // routine must never be able to end the process it runs in.
        options.log.error({ err: error }, 'a cleanup sweep failed');
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, options.intervalMs);
  // So an idle process is not held open by a cleanup timer.
  timer.unref();

  options.log.info({ intervalMs: options.intervalMs }, 'cleanup sweeps scheduled');

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
