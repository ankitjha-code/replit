import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticatedResponseSchema, currentUserResponseSchema } from '@platform/shared';
import { loadEnv } from '../src/config/env.js';
import { hashToken } from '../src/lib/tokens.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * Sign-in, sessions and sign-out through the real HTTP stack and the real
 * database. Requires `pnpm infra:up`.
 *
 * The password hasher is the only substitution, for cost; everything else is
 * the production code path, including the cookie.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

const account = {
  email: 'ada@example.test',
  username: 'ada-lovelace',
  password: 'analytical-engine-1843',
};

function buildApp(overrides: Record<string, string> = {}) {
  const hasher = new FakePasswordHasher();
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_LOGIN_MAX: '100',
    ...overrides,
  } as NodeJS.ProcessEnv);

  const auth = testAuth(db!, config, hasher, silentLogger());
  return { hasher, auth, config, app: testApp({ config, passwordHasher: hasher, auth }) };
}

/** Extracts the session cookie from a Set-Cookie header. */
function sessionCookie(res: request.Response): string | undefined {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  return header?.find((c) => c.startsWith('platform_session='));
}

/** The cookie value in the form a browser would send back. */
function cookieValue(res: request.Response): string {
  const cookie = sessionCookie(res);
  if (!cookie) throw new Error('no session cookie was set');
  return cookie.split(';')[0]!;
}

async function registered(app: ReturnType<typeof buildApp>['app']) {
  return request(app).post('/api/auth/register').send(account).expect(201);
}

afterAll(async () => {
  await db?.$disconnect();
});

describe.skipIf(!db)('registration issues a session', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('signs the new user in immediately', async () => {
    const res = await registered(buildApp().app);

    expect(() => authenticatedResponseSchema.parse(res.body)).not.toThrow();
    expect(sessionCookie(res)).toBeDefined();
  });

  it('stores the session against the new user', async () => {
    await registered(buildApp().app);

    const sessions = await db!.session.findMany();
    expect(sessions).toHaveLength(1);
    const user = await db!.user.findUnique({ where: { email: account.email } });
    expect(sessions[0]?.userId).toBe(user?.id);
  });

  it('lets the new user immediately identify themselves', async () => {
    const { app } = buildApp();
    const res = await registered(app);

    const me = await request(app).get('/api/auth/me').set('Cookie', cookieValue(res)).expect(200);
    expect(me.body.user.username).toBe('ada-lovelace');
  });
});

describe.skipIf(!db)('POST /api/auth/login', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('accepts correct credentials by email', async () => {
    const { app } = buildApp();
    await registered(app);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ identifier: account.email, password: account.password })
      .expect(200);

    expect(res.body.user.username).toBe('ada-lovelace');
    expect(sessionCookie(res)).toBeDefined();
  });

  it('accepts correct credentials by username', async () => {
    const { app } = buildApp();
    await registered(app);

    await request(app)
      .post('/api/auth/login')
      .send({ identifier: account.username, password: account.password })
      .expect(200);
  });

  it('accepts a differently-cased email', async () => {
    const { app } = buildApp();
    await registered(app);

    await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'ADA@Example.TEST', password: account.password })
      .expect(200);
  });

  it('rejects a wrong password without a cookie', async () => {
    const { app } = buildApp();
    await registered(app);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ identifier: account.email, password: 'not-the-password' })
      .expect(401);

    expect(sessionCookie(res)).toBeUndefined();
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('answers identically for an unknown account and a wrong password', async () => {
    const { app } = buildApp();
    await registered(app);

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ identifier: account.email, password: 'not-the-password' })
      .expect(401);

    const unknownAccount = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'nobody@example.test', password: account.password })
      .expect(401);

    // Any difference makes sign-in an oracle for which accounts exist.
    expect(unknownAccount.body.error.message).toBe(wrongPassword.body.error.message);
    expect(unknownAccount.body.error.code).toBe(wrongPassword.body.error.code);
  });

  it('creates a second session rather than replacing the first', async () => {
    // Signing in on a phone must not sign you out on a laptop.
    const { app } = buildApp();
    const first = await registered(app);

    const second = await request(app)
      .post('/api/auth/login')
      .send({ identifier: account.email, password: account.password })
      .expect(200);

    expect(await db!.session.count()).toBe(2);
    expect(cookieValue(second)).not.toBe(cookieValue(first));

    await request(app).get('/api/auth/me').set('Cookie', cookieValue(first)).expect(200);
  });

  it('applies no password policy to sign-in', async () => {
    // A user whose password predates a policy change must still get in. The
    // rejection has to come from verification, not validation.
    const res = await request(buildApp().app)
      .post('/api/auth/login')
      .send({ identifier: 'someone@example.test', password: 'short' })
      .expect(401);

    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an empty body as invalid rather than unauthenticated', async () => {
    await request(buildApp().app).post('/api/auth/login').send({}).expect(422);
  });
});

describe.skipIf(!db)('the session cookie', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('is httpOnly, so script cannot read it', async () => {
    const cookie = sessionCookie(await registered(buildApp().app));
    expect(cookie).toContain('HttpOnly');
  });

  it('is SameSite=Lax', async () => {
    const cookie = sessionCookie(await registered(buildApp().app));
    expect(cookie).toContain('SameSite=Lax');
  });

  it('is scoped to the whole site', async () => {
    expect(sessionCookie(await registered(buildApp().app))).toContain('Path=/');
  });

  it('is not marked Secure in development, where there is no TLS', async () => {
    expect(sessionCookie(await registered(buildApp().app))).not.toContain('Secure');
  });

  it('is marked Secure in production without being asked', async () => {
    const { app } = buildApp({ NODE_ENV: 'production' });
    expect(sessionCookie(await registered(app))).toContain('Secure');
  });

  it('carries the raw token, and the database stores only its digest', async () => {
    const res = await registered(buildApp().app);
    const token = cookieValue(res).split('=')[1]!;

    const stored = await db!.session.findFirst();
    expect(stored?.tokenHash).toBe(hashToken(decodeURIComponent(token)));
    expect(stored?.tokenHash).not.toContain(token);
  });

  it('never appears in the response body', async () => {
    const res = await registered(buildApp().app);
    const token = cookieValue(res).split('=')[1]!;
    expect(JSON.stringify(res.body)).not.toContain(token);
  });
});

describe.skipIf(!db)('GET /api/auth/me', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('answers with a null user when nobody is signed in', async () => {
    const res = await request(buildApp().app).get('/api/auth/me').expect(200);
    expect(() => currentUserResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.user).toBeNull();
  });

  it('never exposes the password hash', async () => {
    const { app } = buildApp();
    const res = await registered(app);

    const me = await request(app).get('/api/auth/me').set('Cookie', cookieValue(res)).expect(200);
    expect(JSON.stringify(me.body)).not.toContain('passwordHash');
    expect(JSON.stringify(me.body)).not.toContain('fake$');
  });

  it('ignores a forged token', async () => {
    const res = await request(buildApp().app)
      .get('/api/auth/me')
      .set('Cookie', `platform_session=${'A'.repeat(43)}`)
      .expect(200);
    expect(res.body.user).toBeNull();
  });

  it('ignores a malformed cookie value', async () => {
    const res = await request(buildApp().app)
      .get('/api/auth/me')
      .set('Cookie', 'platform_session=nonsense')
      .expect(200);
    expect(res.body.user).toBeNull();
  });

  it('ignores a session whose row was deleted', async () => {
    const { app } = buildApp();
    const res = await registered(app);
    await db!.session.deleteMany();

    const me = await request(app).get('/api/auth/me').set('Cookie', cookieValue(res)).expect(200);
    expect(me.body.user).toBeNull();
  });

  it('ignores a session whose user was deleted', async () => {
    const { app } = buildApp();
    const res = await registered(app);
    await db!.user.deleteMany();

    const me = await request(app).get('/api/auth/me').set('Cookie', cookieValue(res)).expect(200);
    expect(me.body.user).toBeNull();
  });

  it('refreshes last-seen once the throttle window has passed', async () => {
    const { app } = buildApp({ SESSION_LAST_SEEN_THROTTLE_SECONDS: '0' });
    const res = await registered(app);
    const before = (await db!.session.findFirst())!.lastSeenAt;

    await new Promise((resolve) => setTimeout(resolve, 25));
    await request(app).get('/api/auth/me').set('Cookie', cookieValue(res)).expect(200);

    const after = (await db!.session.findFirst())!.lastSeenAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});

describe.skipIf(!db)('signing out', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('invalidates the session immediately', async () => {
    const { app } = buildApp();
    const res = await registered(app);
    const cookie = cookieValue(res);

    await request(app).post('/api/auth/logout').set('Cookie', cookie).expect(204);

    const me = await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200);
    expect(me.body.user).toBeNull();
    expect(await db!.session.count()).toBe(0);
  });

  it('clears the cookie in the browser', async () => {
    const { app } = buildApp();
    const res = await registered(app);

    const out = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookieValue(res))
      .expect(204);

    const cleared = sessionCookie(out);
    expect(cleared).toBeDefined();
    // Cleared with matching flags, or the browser keeps the original.
    expect(cleared).toContain('HttpOnly');
  });

  it('succeeds when nobody was signed in', async () => {
    await request(buildApp().app).post('/api/auth/logout').expect(204);
  });

  it('leaves other sessions of the same user alone', async () => {
    const { app } = buildApp();
    const laptop = await registered(app);
    const phone = await request(app)
      .post('/api/auth/login')
      .send({ identifier: account.email, password: account.password })
      .expect(200);

    await request(app).post('/api/auth/logout').set('Cookie', cookieValue(phone)).expect(204);

    await request(app).get('/api/auth/me').set('Cookie', cookieValue(laptop)).expect(200);
    expect(await db!.session.count()).toBe(1);
  });

  it('signs out everywhere on request', async () => {
    const { app } = buildApp();
    const laptop = await registered(app);
    await request(app)
      .post('/api/auth/login')
      .send({ identifier: account.email, password: account.password })
      .expect(200);

    await request(app).post('/api/auth/logout-all').set('Cookie', cookieValue(laptop)).expect(204);

    expect(await db!.session.count()).toBe(0);
    const me = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookieValue(laptop))
      .expect(200);
    expect(me.body.user).toBeNull();
  });

  it('refuses sign-out-everywhere without a session', async () => {
    const res = await request(buildApp().app).post('/api/auth/logout-all').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe.skipIf(!db)('session expiry', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('rejects a session past its absolute expiry', async () => {
    const { app } = buildApp();
    const res = await registered(app);

    await db!.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const me = await request(app).get('/api/auth/me').set('Cookie', cookieValue(res)).expect(200);
    expect(me.body.user).toBeNull();
  });

  it('removes an expired session rather than leaving it to accumulate', async () => {
    const { app } = buildApp();
    const res = await registered(app);
    await db!.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    await request(app).get('/api/auth/me').set('Cookie', cookieValue(res));
    expect(await db!.session.count()).toBe(0);
  });

  it('rejects a session left idle past the idle limit', async () => {
    const { app } = buildApp({ SESSION_IDLE_TTL_HOURS: '1' });
    const res = await registered(app);

    // Still well inside the absolute lifetime.
    await db!.session.updateMany({
      data: { lastSeenAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });

    const me = await request(app).get('/api/auth/me').set('Cookie', cookieValue(res)).expect(200);
    expect(me.body.user).toBeNull();
  });

  it('sweeps expired sessions', async () => {
    const { app, auth } = buildApp();
    await registered(app);
    await db!.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await auth.sessions.sweepExpired()).toBe(1);
    expect(await db!.session.count()).toBe(0);
  });

  it('leaves valid sessions untouched when sweeping', async () => {
    const { app, auth } = buildApp();
    await registered(app);
    expect(await auth.sessions.sweepExpired()).toBe(0);
    expect(await db!.session.count()).toBe(1);
  });
});

describe.skipIf(!db)('sign-in rate limiting', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('stops repeated password guessing', async () => {
    const { app } = buildApp({ RATE_LIMIT_LOGIN_MAX: '3' });
    await registered(app);

    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .post('/api/auth/login')
        .send({ identifier: account.email, password: `guess-${i}` })
        .expect(401);
    }

    const res = await request(app)
      .post('/api/auth/login')
      .send({ identifier: account.email, password: account.password })
      .expect(429);

    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('counts sign-in separately from registration', async () => {
    // Exhausting one must not lock a legitimate user out of the other.
    const { app } = buildApp({ RATE_LIMIT_LOGIN_MAX: '1' });
    await registered(app);

    await request(app)
      .post('/api/auth/login')
      .send({ identifier: account.email, password: 'wrong' })
      .expect(401);
    await request(app)
      .post('/api/auth/login')
      .send({ identifier: account.email, password: 'wrong' })
      .expect(429);

    await request(app)
      .post('/api/auth/register')
      .send({ email: 'other@example.test', username: 'other', password: 'a-fine-passphrase-99' })
      .expect(201);
  });
});

describe.skipIf(!db)('cross-site request forgery defence', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('refuses an unsafe request from an unknown origin', async () => {
    const res = await request(buildApp().app)
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ identifier: account.email, password: account.password })
      .expect(403);

    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('does not echo the rejected origin back', async () => {
    const res = await request(buildApp().app)
      .post('/api/auth/logout')
      .set('Origin', 'https://evil.example')
      .expect(403);

    expect(JSON.stringify(res.body)).not.toContain('evil.example');
  });

  it('allows a request from a configured origin', async () => {
    const { app } = buildApp({ CORS_ORIGINS: 'http://localhost:5173' });
    await request(app)
      .post('/api/auth/register')
      .set('Origin', 'http://localhost:5173')
      .send(account)
      .expect(201);
  });

  it('allows a request with no origin, so non-browser clients still work', async () => {
    await request(buildApp().app).post('/api/auth/register').send(account).expect(201);
  });

  it('leaves safe methods alone', async () => {
    await request(buildApp().app)
      .get('/api/auth/me')
      .set('Origin', 'https://evil.example')
      .expect(200);
  });
});
