import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.js';
import { databaseProbe } from '../src/db/db-probe.js';
import { loadEnv } from '../src/config/env.js';
import { logger } from '../src/lib/logger.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * Exercises the real migrated schema against a real PostgreSQL instance.
 *
 * Requires `pnpm infra:up`. Global setup creates and migrates an isolated
 * database; when the infrastructure is absent these suites skip rather than
 * pass against a substitute.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

afterAll(async () => {
  await db?.$disconnect();
});

const user = (overrides: Partial<Record<string, unknown>> = {}) => ({
  email: 'ada@example.test',
  username: 'ada',
  passwordHash: '$argon2id$placeholder',
  ...overrides,
});

describe.skipIf(!db)('migrated schema', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('applied every migration', async () => {
    const rows = await db!.$queryRaw<{ migration_name: string; finished_at: Date | null }[]>`
      SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at
    `;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.finished_at).not.toBeNull();
    }
  });

  it('created the expected tables', async () => {
    const rows = await db!.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
      ORDER BY tablename
    `;
    // Every model in the schema, and nothing else. A table here that the
    // schema does not name is a migration that drifted from it.
    expect(rows.map((r) => r.tablename)).toEqual([
      'account_quota_overrides',
      'account_tokens',
      'deployment_events',
      'deployments',
      'execution_host_drains',
      'jobs',
      'operator_audit_entries',
      'preview_grants',
      'preview_shares',
      'project_alert_events',
      'project_alert_settings',
      'project_assets',
      'project_database_backups',
      'project_databases',
      'project_deployment_configs',
      'project_domains',
      'project_files',
      'project_git_remotes',
      'project_log_lines',
      'project_members',
      'project_repositories',
      'project_secrets',
      'project_snapshots',
      'project_terminal_sessions',
      'project_variables',
      'projects',
      'runtime_events',
      'runtimes',
      'sessions',
      'totp_recovery_codes',
      'users',
    ]);
  });

  it('enforces one runtime per project in the database', async () => {
    // Two concurrent start requests both find no runtime. This constraint is
    // the only thing that stops both from creating one, so it is checked here
    // rather than assumed from the schema file.
    const rows = await db!.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'runtimes' AND indexdef LIKE '%UNIQUE%'
    `;
    expect(rows.some((row) => row.indexdef.includes('projectId'))).toBe(true);
  });

  it('stores timestamps with a time zone', async () => {
    const rows = await db!.$queryRaw<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'createdAt'
    `;
    expect(rows[0]?.data_type).toBe('timestamp with time zone');
  });
});

describe.skipIf(!db)('user records', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('round-trips a user', async () => {
    const created = await db!.user.create({ data: user() });

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.createdAt).toBeInstanceOf(Date);

    const found = await db!.user.findUnique({ where: { id: created.id } });
    expect(found?.email).toBe('ada@example.test');
  });

  it('generates time-ordered identifiers', async () => {
    const first = await db!.user.create({ data: user() });
    const second = await db!.user.create({
      data: user({ email: 'grace@example.test', username: 'grace' }),
    });
    // UUIDv7 embeds a timestamp, so later rows sort after earlier ones.
    expect(second.id > first.id).toBe(true);
  });

  it('rejects a duplicate email', async () => {
    await db!.user.create({ data: user() });
    await expect(db!.user.create({ data: user({ username: 'other' }) })).rejects.toThrow();
  });

  it('rejects a duplicate username', async () => {
    await db!.user.create({ data: user() });
    await expect(
      db!.user.create({ data: user({ email: 'other@example.test' }) }),
    ).rejects.toThrow();
  });

  it('treats differently-cased emails as distinct at the database level', async () => {
    // Postgres compares text case-sensitively, which is why the application
    // normalises before writing. This documents the constraint the
    // normalisation exists to satisfy.
    await db!.user.create({ data: user() });
    await expect(
      db!.user.create({ data: user({ email: 'ADA@example.test', username: 'ada2' }) }),
    ).resolves.toBeDefined();
  });

  it('sets updatedAt on modification', async () => {
    const created = await db!.user.create({ data: user() });
    const updated = await db!.user.update({
      where: { id: created.id },
      data: { displayName: 'Ada Lovelace' },
    });
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });
});

describe.skipIf(!db)('session records', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  const session = (userId: string, tokenHash = 'a'.repeat(64)) => ({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + 86_400_000),
  });

  it('cascades deletion from the owning user', async () => {
    const owner = await db!.user.create({ data: user() });
    await db!.session.create({ data: session(owner.id) });

    await db!.user.delete({ where: { id: owner.id } });

    expect(await db!.session.count()).toBe(0);
  });

  it('refuses a session for a user that does not exist', async () => {
    await expect(
      db!.session.create({ data: session('00000000-0000-7000-8000-000000000000') }),
    ).rejects.toThrow();
  });

  it('rejects a duplicate token hash', async () => {
    const owner = await db!.user.create({ data: user() });
    await db!.session.create({ data: session(owner.id) });
    await expect(db!.session.create({ data: session(owner.id) })).rejects.toThrow();
  });

  it('stores an IP address in a real inet column', async () => {
    const owner = await db!.user.create({ data: user() });
    const created = await db!.session.create({
      data: { ...session(owner.id), ipAddress: '203.0.113.9' },
    });
    expect(created.ipAddress).toBe('203.0.113.9');
  });

  it('rejects a malformed IP address', async () => {
    const owner = await db!.user.create({ data: user() });
    await expect(
      db!.session.create({ data: { ...session(owner.id), ipAddress: 'not-an-ip' } }),
    ).rejects.toThrow();
  });
});

describe.skipIf(!url)('transactions', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('rolls back every write when one fails', async () => {
    await expect(
      db!.$transaction(async (tx) => {
        await tx.user.create({ data: user() });
        await tx.user.create({ data: user() }); // duplicate email
      }),
    ).rejects.toThrow();

    expect(await db!.user.count()).toBe(0);
  });

  it('commits when every write succeeds', async () => {
    await db!.$transaction(async (tx) => {
      await tx.user.create({ data: user() });
      await tx.user.create({ data: user({ email: 'grace@example.test', username: 'grace' }) });
    });

    expect(await db!.user.count()).toBe(2);
  });
});

describe.skipIf(!url)('database health probe', () => {
  it('reports up against a working connection', async () => {
    const result = await databaseProbe(db!).check();
    expect(result.status).toBe('up');
    expect(result.detail).toBe('query ok');
  });

  it('reports down when the query fails, without leaking the connection string', async () => {
    const handle = createDatabase(
      loadEnv({
        DATABASE_URL: 'postgresql://nobody:hunter2@127.0.0.1:1/missing',
        DATABASE_CONNECT_TIMEOUT_MS: '300',
      } as NodeJS.ProcessEnv),
      logger(),
    );

    const result = await databaseProbe(handle.client).check();
    expect(result.status).toBe('down');
    expect(JSON.stringify(result)).not.toContain('hunter2');

    await handle.disconnect();
  });

  it('refuses to connect to an unreachable database rather than reporting healthy', async () => {
    const handle = createDatabase(
      loadEnv({
        DATABASE_URL: 'postgresql://nobody:secret@127.0.0.1:1/missing',
        DATABASE_CONNECT_TIMEOUT_MS: '300',
      } as NodeJS.ProcessEnv),
      logger(),
    );

    await expect(handle.connect()).rejects.toThrow();
    await handle.disconnect();
  });
});
