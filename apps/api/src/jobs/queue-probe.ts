import type { DependencyProbe } from '../modules/health/health.service.js';
import type { JobQueue } from './queue.js';

/**
 * Health probe for the job queue.
 *
 * Registered only when a real one is configured. The in-process queue has
 * nothing to be unreachable — the nudge is a function call — and a permanently
 * green row saying so would be noise on a page whose value is that every row on
 * it means something.
 *
 * Reported as **degraded** rather than down when it cannot be reached, which is
 * the honest severity: work is still recorded, still claimed and still done,
 * just on the next poll instead of immediately. Calling that "down" would make
 * readiness fail for a platform that is working.
 */
export function queueProbe(queue: JobQueue): DependencyProbe {
  return {
    name: `queue:${queue.name}`,
    check: async () => {
      const reason = await queue.unavailableReason();
      return reason === null
        ? { status: 'up' as const, detail: 'reachable' }
        : { status: 'unknown' as const, detail: reason };
    },
  };
}
