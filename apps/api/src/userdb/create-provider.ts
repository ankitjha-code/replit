import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import { PostgresUserDatabaseProvider } from './postgres-provider.js';
import type { UserDatabaseProvider } from './provider.js';
import { UnavailableUserDatabaseProvider } from './unavailable-provider.js';

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
