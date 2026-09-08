import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * Account management, email flows and operator access through the real HTTP
 * stack and the real database. Requires `pnpm infra:up`.
 *
 * Mail is the provider an installation without a mail server actually has — it
 * refuses — which is the path most installations are on.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

const ada = { email: 'ada@example.test', username: 'ada', password: 'analytical-engine-1843' };
const bob = { email: 'bob@example.test', username: 'bob', password: 'difference-engine-1822' };

function buildApp() {
  const hasher = new FakePasswordHasher();
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_LOGIN_MAX: '100',
    RATE_LIMIT_ACCOUNT_MAX: '100',
    RATE_LIMIT_MAIL_MAX: '100',
    RATE_LIMIT_GLOBAL_MAX: '10000',
  } as NodeJS.ProcessEnv);
  const auth = testAuth(db!, config, hasher, silentLogger());
  return testApp({ config, passwordHasher: hasher, auth });
}

function cookieOf(res: request.Response): string {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = header?.find((c) => c.startsWith('platform_session='));
  if (!cookie) throw new Error('no session cookie was set');
  return cookie.split(';')[0]!;
}

async function register(app: ReturnType<typeof buildApp>, account: typeof ada) {
  return cookieOf(await request(app).post('/api/auth/register').send(account).expect(201));
}

async function signIn(app: ReturnType<typeof buildApp>, account: typeof ada) {
  return cookieOf(
    await request(app)
      .post('/api/auth/login')
      .send({ identifier: account.email, password: account.password })
      .expect(200),
  );
}

afterAll(async () => {
  await db?.$disconnect();
});

describe.skipIf(!db)('sessions an account can see and end', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('lists every session, with no credential in the response', async () => {
    const app = buildApp();
    const first = await register(app, ada);
    await signIn(app, ada);

    const res = await request(app).get('/api/account/sessions').set('Cookie', first).expect(200);

    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toMatch(/tokenHash|platform_session/);
  });

  it('a session that was ended stops working on its very next request', async () => {
    // The point of the whole feature.
    const app = buildApp();
    const mine = await register(app, ada);
    const stolen = await signIn(app, ada);

    await request(app).get('/api/auth/me').set('Cookie', stolen).expect(200);
    await request(app).post('/api/account/sessions/revoke-others').set('Cookie', mine).expect(200);

    const after = await request(app).get('/api/auth/me').set('Cookie', stolen).expect(200);
    expect(after.body.user).toBeNull();
    await request(app).get('/api/account/sessions').set('Cookie', mine).expect(200);
  });

  it('cannot end another account’s session, and says not found', async () => {
    const app = buildApp();
    const adaCookie = await register(app, ada);
    const bobCookie = await register(app, bob);

    const bobs = await request(app).get('/api/account/sessions').set('Cookie', bobCookie);
    const bobSession = bobs.body.sessions[0].id as string;

    await request(app)
      .delete(`/api/account/sessions/${bobSession}`)
      .set('Cookie', adaCookie)
      .expect(404);
    await request(app).get('/api/account/sessions').set('Cookie', bobCookie).expect(200);
  });

  it('changing a password signs the other sessions out and keeps this one', async () => {
    const app = buildApp();
    const mine = await register(app, ada);
    const other = await signIn(app, ada);

    await request(app)
      .post('/api/account/password')
      .set('Cookie', mine)
      .send({ currentPassword: ada.password, newPassword: 'a-completely-new-passphrase' })
      .expect(200);

    expect((await request(app).get('/api/auth/me').set('Cookie', other)).body.user).toBeNull();
    expect((await request(app).get('/api/auth/me').set('Cookie', mine)).body.user).not.toBeNull();
  });
});

describe.skipIf(!db)('closing an account', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('removes the account and its projects, and leaves other people alone', async () => {
    const app = buildApp();
    const adaCookie = await register(app, ada);
    const bobCookie = await register(app, bob);

    await request(app)
      .post('/api/projects')
      .set('Cookie', adaCookie)
      .send({ name: 'Engine' })
      .expect(201);

    await request(app)
      .delete('/api/account')
      .set('Cookie', adaCookie)
      .send({ password: ada.password, confirmUsername: 'ADA' })
      .expect(200);

    expect(await db!.user.count({ where: { username: 'ada' } })).toBe(0);
    expect(await db!.project.count()).toBe(0);
    expect(
      (await request(app).get('/api/auth/me').set('Cookie', bobCookie)).body.user,
    ).not.toBeNull();
  });
});

describe.skipIf(!db)('resetting a password', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('answers identically whether or not the address has an account', async () => {
    const app = buildApp();
    await register(app, ada);

    const known = await request(app)
      .post('/api/auth/password-reset')
      .send({ email: ada.email })
      .expect(202);
    const unknown = await request(app)
      .post('/api/auth/password-reset')
      .send({ email: 'nobody@example.test' })
      .expect(202);

    expect(known.body).toEqual(unknown.body);
  });

  it('says that mail is unavailable here, rather than offering a button that fails', async () => {
    const app = buildApp();
    const cookie = await register(app, ada);

    const res = await request(app).get('/api/auth/verification').set('Cookie', cookie).expect(200);

    expect(res.body).toMatchObject({ verified: false, canSend: false });
    expect(res.body.reason).toBeTruthy();
  });
});

describe.skipIf(!db)('operators', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  const paths = [
    ['get', '/api/operations/overview'],
    ['get', '/api/operations/hosts'],
    ['get', '/api/operations/accounts'],
    ['post', '/api/operations/sweep'],
  ] as const;

  it.each(paths)(
    '%s %s answers not found to an account that is not an operator',
    async (method, path) => {
      const app = buildApp();
      const cookie = await register(app, ada);
      await request(app)[method](path).set('Cookie', cookie).send({}).expect(404);
    },
  );

  it('shows an operator the installation, with no project content in it', async () => {
    const app = buildApp();
    const cookie = await register(app, ada);
    await request(app)
      .post('/api/projects')
      .set('Cookie', cookie)
      .send({ name: 'Secret sauce', description: 'do not show operators this' })
      .expect(201);
    await db!.user.update({ where: { username: 'ada' }, data: { isOperator: true } });

    const overview = await request(app)
      .get('/api/operations/overview')
      .set('Cookie', cookie)
      .expect(200);
    const accounts = await request(app)
      .get('/api/operations/accounts')
      .set('Cookie', cookie)
      .expect(200);

    expect(overview.body.projects.total).toBe(1);
    expect(JSON.stringify([overview.body, accounts.body])).not.toContain('do not show operators');
  });

  it('will not let an operator remove themselves, or the last operator be removed', async () => {
    const app = buildApp();
    const cookie = await register(app, ada);
    await db!.user.update({ where: { username: 'ada' }, data: { isOperator: true } });
    const self = await db!.user.findUniqueOrThrow({ where: { username: 'ada' } });

    await request(app)
      .put(`/api/operations/accounts/${self.id}/operator`)
      .set('Cookie', cookie)
      .send({ isOperator: false })
      .expect(422);
    expect((await db!.user.findUniqueOrThrow({ where: { id: self.id } })).isOperator).toBe(true);
  });

  it('writes down who granted operator to whom, and each sweep, in the audit trail', async () => {
    const app = buildApp();
    const adaCookie = await register(app, ada);
    await register(app, bob);
    await db!.user.update({ where: { username: 'ada' }, data: { isOperator: true } });
    const bobRow = await db!.user.findUniqueOrThrow({ where: { username: 'bob' } });

    await request(app)
      .put(`/api/operations/accounts/${bobRow.id}/operator`)
      .set('Cookie', adaCookie)
      .send({ isOperator: true })
      .expect(204);
    await request(app).post('/api/operations/sweep').set('Cookie', adaCookie).send({}).expect(200);

    const trail = await request(app)
      .get('/api/operations/audit')
      .set('Cookie', adaCookie)
      .expect(200);
    const entries = trail.body.entries as {
      actor: string;
      action: string;
      target: string | null;
    }[];

    expect(entries.map((e) => e.action)).toEqual(['sweep.run', 'operator.grant']);
    expect(entries[1]).toMatchObject({ actor: 'ada', target: 'bob' });
  });

  it('keeps the record when the operator’s account is closed', async () => {
    const app = buildApp();
    const adaCookie = await register(app, ada);
    await register(app, bob);
    await db!.user.updateMany({ data: { isOperator: true } });

    await request(app).post('/api/operations/sweep').set('Cookie', adaCookie).send({}).expect(200);
    await request(app)
      .delete('/api/account')
      .set('Cookie', adaCookie)
      .send({ password: ada.password, confirmUsername: 'ada' })
      .expect(200);

    const entries = await db!.operatorAuditEntry.findMany();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorId: null, actorName: 'ada', action: 'sweep.run' });
  });

  it('runs a cleanup sweep as a dry run by default', async () => {
    const app = buildApp();
    const cookie = await register(app, ada);
    await db!.user.update({ where: { username: 'ada' }, data: { isOperator: true } });

    const res = await request(app)
      .post('/api/operations/sweep')
      .set('Cookie', cookie)
      .send({})
      .expect(200);
    expect(res.body.dryRun).toBe(true);
  });
});

describe.skipIf(!db)('per-account ceilings set by an operator', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  async function setUp() {
    const app = buildApp();
    const adaCookie = await register(app, ada);
    const bobCookie = await register(app, bob);
    await db!.user.update({ where: { username: 'ada' }, data: { isOperator: true } });
    const bobRow = await db!.user.findUniqueOrThrow({ where: { username: 'bob' } });
    return { app, adaCookie, bobCookie, bobId: bobRow.id };
  }

  it('raises one account’s ceiling, which that account then sees and is held to', async () => {
    const { app, adaCookie, bobCookie, bobId } = await setUp();

    const before = await request(app).get('/api/quotas').set('Cookie', bobCookie).expect(200);
    const defaultRuntimes = before.body.quotas.find((q: { kind: string }) => q.kind === 'RUNTIMES')
      .limit as number;

    const set = await request(app)
      .put(`/api/operations/accounts/${bobId}/quotas`)
      .set('Cookie', adaCookie)
      .send({ kind: 'RUNTIMES', limit: defaultRuntimes + 5 })
      .expect(200);
    const runtimes = set.body.quotas.find((q: { kind: string }) => q.kind === 'RUNTIMES');
    expect(runtimes).toMatchObject({
      limit: defaultRuntimes + 5,
      defaultLimit: defaultRuntimes,
      overridden: true,
    });

    const after = await request(app).get('/api/quotas').set('Cookie', bobCookie).expect(200);
    const seen = after.body.quotas.find((q: { kind: string }) => q.kind === 'RUNTIMES');
    expect(seen.limit).toBe(defaultRuntimes + 5);
    // The account holder is told the number, not that it is an exception.
    expect(seen).not.toHaveProperty('overridden');
  });

  it('holds an account to a lowered ceiling when it next starts something', async () => {
    const { app, adaCookie, bobCookie, bobId } = await setUp();
    const project = await request(app)
      .post('/api/projects')
      .set('Cookie', bobCookie)
      .send({ name: 'Busy' })
      .expect(201);
    const projectId = project.body.project.id as string;

    // One runtime counted against bob.
    await db!.runtime.create({
      data: {
        projectId,
        status: 'RUNNING',
        provider: 'docker',
        language: 'node',
        version: '22',
        image: 'node:22-alpine',
        cpuMillicores: 500,
        memoryMb: 256,
        pidsLimit: 64,
      },
    });

    await request(app)
      .put(`/api/operations/accounts/${bobId}/quotas`)
      .set('Cookie', adaCookie)
      .send({ kind: 'RUNTIMES', limit: 1 })
      .expect(200);

    const { quotas } = testAuthFor();
    await expect(quotas.require(projectId, 'RUNTIMES')).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    // Back on the default, the same start is allowed again.
    await request(app)
      .put(`/api/operations/accounts/${bobId}/quotas`)
      .set('Cookie', adaCookie)
      .send({ kind: 'RUNTIMES', limit: null })
      .expect(200);
    await expect(quotas.require(projectId, 'RUNTIMES')).resolves.toBeUndefined();
  });

  it('is operators only, bounded, and audited', async () => {
    const { app, adaCookie, bobCookie, bobId } = await setUp();

    await request(app)
      .put(`/api/operations/accounts/${bobId}/quotas`)
      .set('Cookie', bobCookie)
      .send({ kind: 'BUILDS', limit: 50 })
      .expect(404);
    await request(app)
      .put(`/api/operations/accounts/${bobId}/quotas`)
      .set('Cookie', adaCookie)
      .send({ kind: 'BUILDS', limit: 100_000 })
      .expect(422);
    await request(app)
      .put(`/api/operations/accounts/${bobId}/quotas`)
      .set('Cookie', adaCookie)
      .send({ kind: 'NOT_A_KIND', limit: 2 })
      .expect(422);
    await request(app)
      .put('/api/operations/accounts/018f0000-0000-7000-8000-000000000000/quotas')
      .set('Cookie', adaCookie)
      .send({ kind: 'BUILDS', limit: 2 })
      .expect(404);

    await request(app)
      .put(`/api/operations/accounts/${bobId}/quotas`)
      .set('Cookie', adaCookie)
      .send({ kind: 'BUILDS', limit: 4 })
      .expect(200);

    const trail = await request(app)
      .get('/api/operations/audit')
      .set('Cookie', adaCookie)
      .expect(200);
    expect(trail.body.entries).toContainEqual(
      expect.objectContaining({
        actor: 'ada',
        action: 'quota.override',
        target: 'bob',
        detail: { kind: 'BUILDS', limit: 4 },
      }),
    );
  });
});

/** The service graph on its own, for asserting what a start would be told. */
function testAuthFor() {
  const config = loadEnv({} as NodeJS.ProcessEnv);
  return testAuth(db!, config, new FakePasswordHasher(), silentLogger());
}

describe.skipIf(!db)('draining an execution host', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  function appWithHosts(hosts: object[]) {
    const hasher = new FakePasswordHasher();
    const config = loadEnv({
      RATE_LIMIT_REGISTER_MAX: '100',
      EXECUTION_HOSTS: JSON.stringify(hosts),
    } as NodeJS.ProcessEnv);
    return testApp({
      config,
      passwordHasher: hasher,
      auth: testAuth(db!, config, hasher, silentLogger()),
    });
  }
  const twoHosts = [
    { name: 'alpha', cpuMillicores: 4000, memoryMb: 4096, maxWorkloads: 10 },
    { name: 'beta', cpuMillicores: 4000, memoryMb: 4096, maxWorkloads: 10 },
  ];

  it('takes a host out of placement, says so, and records who did it', async () => {
    const app = appWithHosts(twoHosts);
    const cookie = await register(app, ada);
    await db!.user.update({ where: { username: 'ada' }, data: { isOperator: true } });

    const drained = await request(app)
      .put('/api/operations/hosts/alpha/drain')
      .set('Cookie', cookie)
      .send({ draining: true })
      .expect(200);
    expect(drained.body.hosts.find((h: { name: string }) => h.name === 'alpha')).toMatchObject({
      draining: true,
      schedulable: false,
    });
    expect(await db!.executionHostDrain.count()).toBe(1);

    const back = await request(app)
      .put('/api/operations/hosts/alpha/drain')
      .set('Cookie', cookie)
      .send({ draining: false })
      .expect(200);
    expect(back.body.hosts.find((h: { name: string }) => h.name === 'alpha').draining).toBe(false);

    const trail = await request(app).get('/api/operations/audit').set('Cookie', cookie).expect(200);
    expect(trail.body.entries.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['host.drain', 'host.undrain']),
    );
  });

  it('refuses with one host, an unknown host, or a caller who is not an operator', async () => {
    const single = appWithHosts([twoHosts[0]!]);
    const cookie = await register(single, ada);
    await db!.user.update({ where: { username: 'ada' }, data: { isOperator: true } });
    await request(single)
      .put('/api/operations/hosts/alpha/drain')
      .set('Cookie', cookie)
      .send({ draining: true })
      .expect(412);

    const two = appWithHosts(twoHosts);
    await request(two)
      .put('/api/operations/hosts/gamma/drain')
      .set('Cookie', cookie)
      .send({ draining: true })
      .expect(404);

    const bobCookie = await register(two, bob);
    await request(two)
      .put('/api/operations/hosts/alpha/drain')
      .set('Cookie', bobCookie)
      .send({ draining: true })
      .expect(404);
  });
});
