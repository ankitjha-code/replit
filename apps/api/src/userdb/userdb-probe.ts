import type { DependencyProbe } from '../modules/health/health.service.js';
import type { UserDatabaseProvider } from './provider.js';

/**
 * Health probe for the server that holds project databases.
 *
 * Registered only when one is configured. An installation deliberately running
 * without one is not unhealthy, and reporting it as down would make readiness
 * useless for the thing it is actually for.
 *
 * The provider's own reason is reported, because it is already written to be
 * shown and carries no internal detail. In particular it carries no host, no
 * port and no credential.
 */
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
