import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { registerResponseSchema } from '@platform/shared';
import { loadEnv } from '../src/config/env.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, testApp, testAuth } from './setup/app.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * Registration end to end through the real HTTP stack and the real database.
 *
 * Requires `pnpm infra:up`. The password hasher is the only substitution: real
 * Argon2 costs 19 MiB and tens of milliseconds per call by design, and it has
 * its own unit tests. Everything else here is the production code path.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;
const silent = pino({ level: 'silent' });

const valid = {
  email: 'ada@example.test',
  username: 'ada-lovelace',
  password: 'analytical-engine-1843',
};

function buildApp(overrides: { registerMax?: number } = {}) {
  const hasher = new FakePasswordHasher();
  const config = loadEnv({
    ...(overrides.registerMax === undefined
      ? {}
      : { RATE_LIMIT_REGISTER_MAX: String(overrides.registerMax) }),
  } as NodeJS.ProcessEnv);

  return {
    hasher,
    app: testApp({
      config,
      passwordHasher: hasher,
      auth: testAuth(db!, config, hasher, silent),
    }),
  };
}

afterAll(async () => {
  await db?.$disconnect();
});

describe.skipIf(!db)('POST /api/auth/register', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('creates an account and answers 201', async () => {
    const res = await request(buildApp().app).post('/api/auth/register').send(valid).expect(201);

    expect(() => registerResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.user.username).toBe('ada-lovelace');
    expect(res.body.user.email).toBe('ada@example.test');
  });

  it('actually persists the row', async () => {
    await request(buildApp().app).post('/api/auth/register').send(valid).expect(201);

    const stored = await db!.user.findUnique({ where: { email: 'ada@example.test' } });
    expect(stored).not.toBeNull();
    expect(stored?.username).toBe('ada-lovelace');
  });

  it('never returns the password or its hash', async () => {
    const res = await request(buildApp().app).post('/api/auth/register').send(valid).expect(201);

    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain(valid.password);
    expect(serialised).not.toContain('passwordHash');
    expect(serialised).not.toContain('fake$');
  });

  it('stores a hash rather than the password', async () => {
    await request(buildApp().app).post('/api/auth/register').send(valid).expect(201);

    const stored = await db!.user.findUnique({ where: { email: 'ada@example.test' } });
    expect(stored?.passwordHash).not.toContain(valid.password);
    expect(stored?.passwordHash.length).toBeGreaterThan(20);
  });

  it('normalises the email so a differently-cased duplicate is caught', async () => {
    const { app } = buildApp();
    await request(app).post('/api/auth/register').send(valid).expect(201);

    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...valid, email: 'ADA@Example.TEST', username: 'someone-else' })
      .expect(409);

    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.details.field).toBe('email');
    expect(await db!.user.count()).toBe(1);
  });

  it('rejects a duplicate username case-insensitively', async () => {
    const { app } = buildApp();
    await request(app).post('/api/auth/register').send(valid).expect(201);

    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...valid, email: 'other@example.test', username: 'ADA-Lovelace' })
      .expect(409);

    expect(res.body.error.details.field).toBe('username');
  });

  it('rejects an invalid body with field-level detail', async () => {
    const res = await request(buildApp().app)
      .post('/api/auth/register')
      .send({ email: 'nope', username: 'a', password: 'short' })
      .expect(422);

    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const paths = res.body.error.details.fields.map((f: { path: string }) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['email', 'username', 'password']));
    expect(await db!.user.count()).toBe(0);
  });

  it('rejects a reserved username', async () => {
    const res = await request(buildApp().app)
      .post('/api/auth/register')
      .send({ ...valid, username: 'admin' })
      .expect(422);

    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('ignores fields the client invents', async () => {
    // A privilege column added later must not become settable by the client
    // simply because it exists on the model.
    await request(buildApp().app)
      .post('/api/auth/register')
      .send({ ...valid, id: '00000000-0000-7000-8000-00000000dead', isAdmin: true })
      .expect(201);

    const stored = await db!.user.findUnique({ where: { email: valid.email } });
    expect(stored?.id).not.toBe('00000000-0000-7000-8000-00000000dead');
  });

  it('does not hash a password for a duplicate registration', async () => {
    const { app, hasher } = buildApp();
    await request(app).post('/api/auth/register').send(valid).expect(201);
    const after = hasher.hashed.length;

    await request(app)
      .post('/api/auth/register')
      .send({ ...valid, username: 'another' })
      .expect(409);

    expect(hasher.hashed.length).toBe(after);
  });

  it('assigns a time-ordered identifier', async () => {
    const { app } = buildApp();
    const first = await request(app).post('/api/auth/register').send(valid).expect(201);
    const second = await request(app)
      .post('/api/auth/register')
      .send({ email: 'grace@example.test', username: 'grace', password: 'compiler-pioneer-1952' })
      .expect(201);

    expect(second.body.user.id > first.body.user.id).toBe(true);
  });

  it('rejects a request with no body', async () => {
    await request(buildApp().app).post('/api/auth/register').expect(422);
  });

  it('does not accept GET on the registration endpoint', async () => {
    await request(buildApp().app).get('/api/auth/register').expect(404);
  });
});

describe.skipIf(!db)('registration rate limiting', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('rejects further attempts once the limit is passed', async () => {
    const { app } = buildApp({ registerMax: 3 });

    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .post('/api/auth/register')
        .send({ ...valid, email: `user${i}@example.test`, username: `user${i}` })
        .expect(201);
    }

    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...valid, email: 'user9@example.test', username: 'user9' })
      .expect(429);

    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('counts invalid attempts too, so enumeration is not free', async () => {
    const { app } = buildApp({ registerMax: 2 });

    await request(app).post('/api/auth/register').send({ email: 'x' }).expect(422);
    await request(app).post('/api/auth/register').send({ email: 'x' }).expect(422);
    await request(app).post('/api/auth/register').send(valid).expect(429);
  });

  it('advertises the remaining allowance', async () => {
    const { app } = buildApp({ registerMax: 5 });
    const res = await request(app).post('/api/auth/register').send(valid).expect(201);

    expect(res.headers['ratelimit-limit']).toBe('5');
    expect(res.headers['ratelimit-remaining']).toBe('4');
  });

  it('does not let a forged forwarding header reset the count', async () => {
    // TRUST_PROXY is off by default, so Express ignores the header entirely.
    const { app } = buildApp({ registerMax: 1 });

    await request(app).post('/api/auth/register').send(valid).expect(201);
    await request(app)
      .post('/api/auth/register')
      .set('X-Forwarded-For', '203.0.113.9')
      .send({ ...valid, email: 'other@example.test', username: 'other' })
      .expect(429);
  });
});

describe.skipIf(!db)('registration under concurrency', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('creates exactly one account when the same email arrives at once', async () => {
    // Both requests pass the existence check; the unique constraint is what
    // actually decides.
    const { app } = buildApp({ registerMax: 50 });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        request(app)
          .post('/api/auth/register')
          .send({ ...valid, username: `racer${i}` }),
      ),
    );

    const created = results.filter((r) => r.status === 201);
    const conflicted = results.filter((r) => r.status === 409);

    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(4);
    expect(await db!.user.count()).toBe(1);
  });
});
