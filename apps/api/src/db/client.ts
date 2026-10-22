import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/index.js';
import type { Logger } from 'pino';
import type { Env } from '../config/env.js';

export type Database = PrismaClient;

export interface DatabaseHandle {
  readonly client: Database;
  connect(): Promise<void>;
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
    statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
    application_name: 'platform-control-plane',
  });

  const client = new PrismaClient({
    adapter,
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
