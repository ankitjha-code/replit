import type { Logger } from 'pino';
import type { OrphanSweeper } from './orphan-sweeper.js';

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
    if (running) {
      options.log.warn('a cleanup sweep is still running; skipping this one');
      return;
    }

    running = true;
    void sweeper
      .sweep()
      .catch((error: unknown) => {
        options.log.error({ err: error }, 'a cleanup sweep failed');
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, options.intervalMs);
  timer.unref();

  options.log.info({ intervalMs: options.intervalMs }, 'cleanup sweeps scheduled');

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
