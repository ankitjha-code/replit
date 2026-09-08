import type { DependencyProbe } from '../modules/health/health.service.js';
import type { Database } from './client.js';

/**
 * Health probe that executes a real query.
 *
 * Replaces the TCP reachability probe used before a client existed. The
 * distinction is not pedantic: a Postgres that is accepting connections but
 * refusing queries, out of connections, or in recovery, answers a TCP connect
 * perfectly well while being useless to the platform.
 */
export function databaseProbe(db: Database): DependencyProbe {
  return {
    name: 'postgres',
    check: async () => {
      try {
        await db.$queryRaw`SELECT 1`;
        return { status: 'up' as const, detail: 'query ok' };
      } catch (error) {
        // The driver's message can contain the connection string, so it is
        // never passed through to the response.
        return {
          status: 'down' as const,
          detail: error instanceof Error ? `query failed: ${error.name}` : 'query failed',
        };
      }
    },
  };
}
