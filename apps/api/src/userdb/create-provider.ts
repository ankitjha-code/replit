import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import { PostgresUserDatabaseProvider } from './postgres-provider.js';
import type { UserDatabaseProvider } from './provider.js';
import { UnavailableUserDatabaseProvider } from './unavailable-provider.js';

/**
 * Chooses where project databases are provisioned.
 *
 * Configured or not, rather than by naming a provider: a PostgreSQL server is
 * addressed by one URL, so having one is the whole decision. Absent means the
 * platform cannot give a project a database, and it says so.
 */
export function createUserDatabaseProvider(config: Env, log: Logger): UserDatabaseProvider {
  if (!config.USER_DATABASE_ADMIN_URL) {
    return new UnavailableUserDatabaseProvider();
  }

  return new PostgresUserDatabaseProvider(
    {
      adminUrl: config.USER_DATABASE_ADMIN_URL,
      availabilityTtlMs: config.STORAGE_AVAILABILITY_TTL_MS,
    },
    log,
  );
}
