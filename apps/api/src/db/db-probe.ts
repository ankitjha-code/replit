import type { DependencyProbe } from '../modules/health/health.service.js';
import type { Database } from './client.js';

export function databaseProbe(db: Database): DependencyProbe {
  return {
    name: 'postgres',
    check: async () => {
      try {
        await db.$queryRaw`SELECT 1`;
        return { status: 'up' as const, detail: 'query ok' };
      } catch (error) {
        return {
          status: 'down' as const,
          detail: error instanceof Error ? `query failed: ${error.name}` : 'query failed',
        };
      }
    },
  };
}
