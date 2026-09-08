import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

/**
 * Closes every account the browser tests created, through the platform itself.
 *
 * Each spec signs up a fresh `e2e-…` account, and many start a real container.
 * Nothing stopped them, so every run left containers running and networks held
 * — and on Docker Desktop each running container publishes ports on 127.0.0.1,
 * which then collided with other test suites' servers. Closing the account
 * deletes each project properly: containers, networks, databases, stored files.
 *
 * Runs after every test and before Playwright stops the API, so the API is here
 * to do it. Best-effort: a failure is reported, not fatal.
 */

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
  // A few at a time: each closure stops containers, and the API is shared.
  for (let index = 0; index < rows.length; index += 5) {
    const results = await Promise.all(
      rows.slice(index, index + 5).map((row) => close(row.email, row.username).catch(() => false)),
    );
    closed += results.filter(Boolean).length;
  }
  console.log(`teardown: closed ${closed} of ${rows.length} test accounts`);
}
