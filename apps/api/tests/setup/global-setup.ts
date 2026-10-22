import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

const TEST_DATABASE_NAME = process.env.TEST_DATABASE_NAME ?? 'platform_test';

function loadRootEnv(): void {
  const rootEnv = resolve(import.meta.dirname, '../../../../.env');
  if (existsSync(rootEnv)) {
    process.loadEnvFile(rootEnv);
  }
}

export function withDatabaseName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

async function databaseIsReachable(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

async function ensureDatabaseExists(adminUrl: string, name: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    }
  } finally {
    await client.end();
  }
}

export default async function globalSetup(): Promise<void> {
  loadRootEnv();

  const developmentUrl = process.env.DATABASE_URL;
  if (!developmentUrl) {
    console.warn('\n[database tests skipped] DATABASE_URL is not set.\n');
    return;
  }

  const adminUrl = withDatabaseName(developmentUrl, 'postgres');
  if (!(await databaseIsReachable(adminUrl))) {
    console.warn('\n[database tests skipped] Postgres unreachable. Run: pnpm infra:up\n');
    return;
  }

  await ensureDatabaseExists(adminUrl, TEST_DATABASE_NAME);
  const testUrl = withDatabaseName(developmentUrl, TEST_DATABASE_NAME);

  execFileSync(
    'node',
    [resolve(import.meta.dirname, '../../node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    {
      cwd: resolve(import.meta.dirname, '../..'),
      env: { ...process.env, DATABASE_URL: testUrl },
      stdio: 'pipe',
    },
  );

  process.env.TEST_DATABASE_URL = testUrl;
}
