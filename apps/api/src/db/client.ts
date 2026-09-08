import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/index.js';
import type { Logger } from 'pino';
import type { Env } from '../config/env.js';

/**
 * The platform database connection.
 *
 * Prisma 7 talks to Postgres through a driver adapter, which means the
 * connection pool is ours to configure rather than the ORM's to hide. That
 * matters here: a control plane that serves many concurrent workspaces needs
 * an explicit ceiling on connections and an explicit statement timeout, so one
 * pathological query cannot pin a connection indefinitely.
 */

export type Database = PrismaClient;

export interface DatabaseHandle {
  readonly client: Database;
  /** Verifies the connection is usable. Throws if it is not. */
  connect(): Promise<void>;
  /** Releases every pooled connection. Safe to call more than once. */
  disconnect(): Promise<void>;
}

export function createDatabase(config: Env, log: Logger): DatabaseHandle {
  if (!config.DATABASE_URL) {
    throw new Error('createDatabase called without DATABASE_URL configured');
  }

  const adapter = new PrismaPg({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    connectionTimeoutMillis: config.DATABASE_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: config.DATABASE_IDLE_TIMEOUT_MS,
    // A query that outlives this is aborted by Postgres rather than holding a
    // pooled connection until the client gives up.
    statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
    application_name: 'platform-control-plane',
  });

  const client = new PrismaClient({
    adapter,
    // Query text can embed user data, so it is emitted only at debug level and
    // never in production. Warnings and errors always surface.
    log:
      config.NODE_ENV === 'development' && config.LOG_LEVEL === 'debug'
        ? [
            { emit: 'event', level: 'query' },
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ]
        : [
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ],
  });

  const dbLog = log.child({ component: 'database' });

  client.$on('warn', (event) => dbLog.warn({ target: event.target }, event.message));
  client.$on('error', (event) => dbLog.error({ target: event.target }, event.message));

  if (config.NODE_ENV === 'development' && config.LOG_LEVEL === 'debug') {
    client.$on('query', (event) => {
      dbLog.debug({ durationMs: event.duration }, event.query);
    });
  }

  let closed = false;

  return {
    client,

    async connect() {
      await client.$connect();
      // $connect can succeed against a pool that has not yet handed out a
      // connection, so prove a real round trip before declaring readiness.
      await client.$queryRaw`SELECT 1`;
      dbLog.info({ poolMax: config.DATABASE_POOL_MAX }, 'database connected');
    },

    async disconnect() {
      if (closed) return;
      closed = true;
      await client.$disconnect();
      dbLog.info('database disconnected');
    },
  };
}
