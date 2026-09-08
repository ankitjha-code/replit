import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/index.js';

/**
 * Access to the isolated test database prepared by global setup.
 *
 * `testDatabaseUrl()` returns undefined when the infrastructure is not
 * running, which is the signal for a suite to skip rather than fail.
 */
export function testDatabaseUrl(): string | undefined {
  return process.env.TEST_DATABASE_URL;
}

export function createTestClient(url: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url, max: 4 }),
  });
}

/**
 * Empties every application table between tests.
 *
 * Truncating rather than deleting resets identity sequences too, so one test
 * cannot observe ids left behind by another. The migrations table is left
 * alone: dropping it would force a re-migration on every case.
 */
export async function resetDatabase(client: PrismaClient): Promise<void> {
  const tables = await client.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
  `;

  if (tables.length === 0) return;

  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
