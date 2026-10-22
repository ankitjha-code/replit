import type { DependencyProbe } from '../modules/health/health.service.js';
import type { UserDatabaseProvider } from './provider.js';

export function userDatabaseProbe(provider: UserDatabaseProvider): DependencyProbe {
  return {
    name: `project-databases:${provider.name}`,
    check: async () => {
      const reason = await provider.unavailableReason();
      return reason === null
        ? { status: 'up' as const, detail: 'server reachable' }
        : { status: 'down' as const, detail: reason };
    },
  };
}
