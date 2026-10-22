import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const API = `http://localhost:${process.env.E2E_API_PORT ?? 4000}`;
const PASSWORD = 'analytical-engine-1843';

function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const file = resolve(import.meta.dirname, '../.env');
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('DATABASE_URL='));
  return line?.slice('DATABASE_URL='.length).trim();
}

async function close(email: string, username: string): Promise<boolean> {
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (!login.ok || !cookie) return false;

  const closed = await fetch(`${API}/api/account`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173', cookie },
    body: JSON.stringify({ password: PASSWORD, confirmUsername: username }),
  });
  return closed.ok;
}

export default async function globalTeardown(): Promise<void> {
  const url = databaseUrl();
  if (!url) return;

  const db = new pg.Client({ connectionString: url });
  await db.connect();
  const { rows } = await db.query<{ email: string; username: string }>(
    `SELECT email, username FROM users WHERE username LIKE 'e2e-%' ORDER BY "createdAt" DESC`,
  );
  await db.end();

  let closed = 0;
  for (let index = 0; index < rows.length; index += 5) {
    const results = await Promise.all(
      rows.slice(index, index + 5).map((row) => close(row.email, row.username).catch(() => false)),
    );
    closed += results.filter(Boolean).length;
  }
  console.log(`teardown: closed ${closed} of ${rows.length} test accounts`);
}
