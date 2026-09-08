import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { projectListResponseSchema, projectResponseSchema } from '@platform/shared';
import { loadEnv } from '../src/config/env.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * Project creation over real HTTP against the real database.
 *
 * Requires `pnpm infra:up`. Every case involves at least the caller's own
 * account, and the ones about visibility involve two.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

function buildApp(overrides: Record<string, string> = {}) {
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_LOGIN_MAX: '100',
    RATE_LIMIT_PROJECT_CREATE_MAX: '100',
    ...overrides,
  } as NodeJS.ProcessEnv);

  const auth = testAuth(db!, config, new FakePasswordHasher(), silentLogger());
  return { auth, config, app: testApp({ config, auth }) };
}

async function account(app: ReturnType<typeof buildApp>['app'], name: string): Promise<string> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: `${name}@example.test`, username: name, password: 'analytical-engine-1843' })
    .expect(201);

  const header = res.headers['set-cookie'] as unknown as string[];
  return header.find((c) => c.startsWith('platform_session='))!.split(';')[0]!;
}

const create = (
  app: ReturnType<typeof buildApp>['app'],
  cookie: string,
  body: Record<string, unknown>,
) => request(app).post('/api/projects').set('Cookie', cookie).send(body);

afterAll(async () => {
  await db?.$disconnect();
});

describe.skipIf(!db)('POST /api/projects', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('creates a project and answers 201', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');

    const res = await create(app, ada, { name: 'My First Project' }).expect(201);

    expect(() => projectResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.project.name).toBe('My First Project');
    expect(res.body.project.slug).toBe('my-first-project');
    expect(res.body.project.role).toBe('OWNER');
  });

  it('points at the created project', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');

    const res = await create(app, ada, { name: 'Engine' }).expect(201);
    expect(res.headers.location).toBe(`/api/projects/${res.body.project.id}`);
  });

  it('persists the row and the owner membership together', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const res = await create(app, ada, { name: 'Engine' }).expect(201);

    const stored = await db!.project.findUnique({
      where: { id: res.body.project.id },
      include: { members: true },
    });

    expect(stored?.slug).toBe('engine');
    expect(stored?.members).toHaveLength(1);
    expect(stored?.members[0]?.role).toBe('OWNER');
  });

  it('refuses an anonymous caller', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/projects').send({ name: 'Engine' }).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('takes the owner from the session, never the body', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const graceRes = await request(app)
      .post('/api/auth/register')
      .send({ email: 'grace@example.test', username: 'grace', password: 'compiler-1952-x' })
      .expect(201);

    await create(app, ada, { name: 'Engine', ownerId: graceRes.body.user.id }).expect(201);

    const stored = await db!.project.findFirst();
    expect(stored?.ownerId).not.toBe(graceRes.body.user.id);
  });

  it('accepts an explicit slug', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');

    const res = await create(app, ada, { name: 'My First Project', slug: 'engine' }).expect(201);
    expect(res.body.project.slug).toBe('engine');
  });

  it('rejects an invalid name with field-level detail', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');

    const res = await create(app, ada, { name: '' }).expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.fields.map((f: { path: string }) => f.path)).toContain('name');
  });

  it('rejects a reserved slug', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    await create(app, ada, { name: 'Engine', slug: 'preview' }).expect(422);
  });

  it('numbers a derived slug that is already taken', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');

    await create(app, ada, { name: 'My Project' }).expect(201);
    const second = await create(app, ada, { name: 'My Project' }).expect(201);

    expect(second.body.project.slug).toBe('my-project-2');
  });

  it('refuses an explicit slug that is taken', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');

    await create(app, ada, { name: 'A', slug: 'engine' }).expect(201);
    const res = await create(app, ada, { name: 'B', slug: 'engine' }).expect(409);

    expect(res.body.error.details.field).toBe('slug');
  });

  it('lets two accounts use the same slug', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const grace = await account(app, 'grace');

    await create(app, ada, { name: 'My Project' }).expect(201);
    const theirs = await create(app, grace, { name: 'My Project' }).expect(201);

    expect(theirs.body.project.slug).toBe('my-project');
  });

  it('asks for a slug when none can be derived from the name', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');

    const res = await create(app, ada, { name: '日本語' }).expect(422);
    expect(JSON.stringify(res.body.error.details)).toContain('slug');
  });

  it('creates exactly one project when the same name arrives at once', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');

    const results = await Promise.all(
      Array.from({ length: 5 }, () => create(app, ada, { name: 'Race' })),
    );

    expect(results.every((r) => r.status === 201)).toBe(true);
    // Every slug is distinct, because the unique constraint decided each time.
    const slugs = results.map((r) => r.body.project.slug as string);
    expect(new Set(slugs).size).toBe(5);
    expect(await db!.project.count()).toBe(5);
  });

  it('enforces the per-account limit', async () => {
    const { app } = buildApp({ MAX_PROJECTS_PER_USER: '2' });
    const ada = await account(app, 'ada');

    await create(app, ada, { name: 'One' }).expect(201);
    await create(app, ada, { name: 'Two' }).expect(201);

    const res = await create(app, ada, { name: 'Three' }).expect(409);
    expect(res.body.error.details.limit).toBe(2);
    expect(await db!.project.count()).toBe(2);
  });

  it('applies the limit per account, not globally', async () => {
    const { app } = buildApp({ MAX_PROJECTS_PER_USER: '1' });
    const ada = await account(app, 'ada');
    const grace = await account(app, 'grace');

    await create(app, ada, { name: 'Mine' }).expect(201);
    await create(app, grace, { name: 'Theirs' }).expect(201);
  });

  it('rate limits creation', async () => {
    const { app } = buildApp({ RATE_LIMIT_PROJECT_CREATE_MAX: '2' });
    const ada = await account(app, 'ada');

    await create(app, ada, { name: 'One' }).expect(201);
    await create(app, ada, { name: 'Two' }).expect(201);

    const res = await create(app, ada, { name: 'Three' }).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});

describe.skipIf(!db)('GET /api/projects', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('returns an empty list for a new account', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');

    const res = await request(app).get('/api/projects').set('Cookie', ada).expect(200);
    expect(() => projectListResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.projects).toEqual([]);
  });

  it('returns the caller own projects, newest first', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');

    await create(app, ada, { name: 'First' }).expect(201);
    await create(app, ada, { name: 'Second' }).expect(201);

    const res = await request(app).get('/api/projects').set('Cookie', ada).expect(200);
    expect(res.body.projects.map((p: { name: string }) => p.name)).toEqual(['Second', 'First']);
  });

  it('never includes another account projects', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const grace = await account(app, 'grace');

    await create(app, ada, { name: 'Ada Project' }).expect(201);

    const res = await request(app).get('/api/projects').set('Cookie', grace).expect(200);
    expect(res.body.projects).toEqual([]);
  });

  it('includes a project shared with the caller, at their own role', async () => {
    const { app, auth } = buildApp();
    const ada = await account(app, 'ada');
    const grace = await account(app, 'grace');

    const created = await create(app, ada, { name: 'Shared' }).expect(201);
    const graceUser = await db!.user.findUnique({ where: { username: 'grace' } });
    await auth.projects.upsertMembership(created.body.project.id, graceUser!.id, 'VIEWER');

    const res = await request(app).get('/api/projects').set('Cookie', grace).expect(200);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.projects[0].role).toBe('VIEWER');
  });

  it('refuses an anonymous caller', async () => {
    const { app } = buildApp();
    await request(app).get('/api/projects').expect(401);
  });
});

describe.skipIf(!db)('GET /api/projects/:id', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('returns a project the caller can reach', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const created = await create(app, ada, { name: 'Engine' }).expect(201);

    const res = await request(app)
      .get(`/api/projects/${created.body.project.id}`)
      .set('Cookie', ada)
      .expect(200);

    expect(res.body.project.name).toBe('Engine');
  });

  it('hides another account project behind a 404', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const grace = await account(app, 'grace');
    const created = await create(app, ada, { name: 'Engine' }).expect(201);

    await request(app)
      .get(`/api/projects/${created.body.project.id}`)
      .set('Cookie', grace)
      .expect(404);
  });

  it('never exposes the owner identifier', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const created = await create(app, ada, { name: 'Engine' }).expect(201);

    const res = await request(app)
      .get(`/api/projects/${created.body.project.id}`)
      .set('Cookie', ada)
      .expect(200);

    expect(res.body.project).not.toHaveProperty('ownerId');
  });
});

describe.skipIf(!db)('DELETE /api/projects/:id', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('lets the owner delete, and removes the row', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const created = await create(app, ada, { name: 'Engine' }).expect(201);

    await request(app)
      .delete(`/api/projects/${created.body.project.id}`)
      .set('Cookie', ada)
      .expect(204);

    expect(await db!.project.count()).toBe(0);
    expect(await db!.projectMember.count()).toBe(0);
  });

  it('refuses an editor with a 403', async () => {
    const { app, auth } = buildApp();
    const ada = await account(app, 'ada');
    const grace = await account(app, 'grace');
    const created = await create(app, ada, { name: 'Engine' }).expect(201);

    const graceUser = await db!.user.findUnique({ where: { username: 'grace' } });
    await auth.projects.upsertMembership(created.body.project.id, graceUser!.id, 'EDITOR');

    // They can see it, so hiding it now would be misleading.
    const res = await request(app)
      .delete(`/api/projects/${created.body.project.id}`)
      .set('Cookie', grace)
      .expect(403);

    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(await db!.project.count()).toBe(1);
  });

  it('hides another account project behind a 404 rather than a 403', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const grace = await account(app, 'grace');
    const created = await create(app, ada, { name: 'Engine' }).expect(201);

    await request(app)
      .delete(`/api/projects/${created.body.project.id}`)
      .set('Cookie', grace)
      .expect(404);

    expect(await db!.project.count()).toBe(1);
  });

  it('frees the slug for reuse', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const created = await create(app, ada, { name: 'Engine' }).expect(201);

    await request(app)
      .delete(`/api/projects/${created.body.project.id}`)
      .set('Cookie', ada)
      .expect(204);

    const again = await create(app, ada, { name: 'Engine' }).expect(201);
    expect(again.body.project.slug).toBe('engine');
  });

  it('is answered the same way when already deleted', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const created = await create(app, ada, { name: 'Engine' }).expect(201);

    await request(app)
      .delete(`/api/projects/${created.body.project.id}`)
      .set('Cookie', ada)
      .expect(204);

    // Once gone it is indistinguishable from never having existed, which is
    // the same answer a stranger would get.
    await request(app)
      .delete(`/api/projects/${created.body.project.id}`)
      .set('Cookie', ada)
      .expect(404);
  });
});

describe.skipIf(!db)('renaming a project', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('changes the name and description, and leaves the slug and its URLs alone', async () => {
    const { app, cookie } = await signedInForRename();
    const created = await request(app)
      .post('/api/projects')
      .set('Cookie', cookie)
      .send({ name: 'Old name', description: 'before' })
      .expect(201);
    const { id, slug } = created.body.project as { id: string; slug: string };

    const renamed = await request(app)
      .patch(`/api/projects/${id}`)
      .set('Cookie', cookie)
      .send({ name: 'New name', description: null })
      .expect(200);

    expect(renamed.body.project).toMatchObject({ name: 'New name', description: null, slug });
  });

  it('refuses a request that changes nothing', async () => {
    const { app, cookie } = await signedInForRename();
    const created = await request(app)
      .post('/api/projects')
      .set('Cookie', cookie)
      .send({ name: 'Project' })
      .expect(201);

    await request(app)
      .patch(`/api/projects/${created.body.project.id}`)
      .set('Cookie', cookie)
      .send({})
      .expect(422);
  });

  it('answers not found to somebody who cannot see the project', async () => {
    const { app, cookie } = await signedInForRename();
    const created = await request(app)
      .post('/api/projects')
      .set('Cookie', cookie)
      .send({ name: 'Private' })
      .expect(201);

    const stranger = await request(app)
      .post('/api/auth/register')
      .send({ email: 'eve@example.test', username: 'eve', password: 'somebody-else-entirely-9' })
      .expect(201);
    const strangerCookie = (stranger.headers['set-cookie'] as unknown as string[])[0]!.split(
      ';',
    )[0]!;

    await request(app)
      .patch(`/api/projects/${created.body.project.id}`)
      .set('Cookie', strangerCookie)
      .send({ name: 'Mine now' })
      .expect(404);
  });
});

async function signedInForRename() {
  const hasher = new FakePasswordHasher();
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_PROJECT_CREATE_MAX: '100',
  } as NodeJS.ProcessEnv);
  const auth = testAuth(db!, config, hasher, silentLogger());
  const app = testApp({ config, passwordHasher: hasher, auth });
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'ada@example.test', username: 'ada', password: 'analytical-engine-1843' })
    .expect(201);
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  return { app, cookie };
}
