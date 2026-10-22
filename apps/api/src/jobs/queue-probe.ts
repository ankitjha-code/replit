import type { DependencyProbe } from '../modules/health/health.service.js';
import type { JobQueue } from './queue.js';

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
