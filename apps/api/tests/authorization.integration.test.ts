import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { projectMembersResponseSchema, type ProjectRole } from '@platform/shared';
import { loadEnv } from '../src/config/env.js';
import { AuthorizationService } from '../src/modules/projects/authorization.service.js';
import { ProjectRepository } from '../src/modules/projects/project.repository.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * Project authorization against the real database, driven over real HTTP.
 *
 * Requires `pnpm infra:up`. What matters here is what one user can and cannot
 * see of another user's project, so every case involves at least two accounts.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

const config = () =>
  loadEnv({ RATE_LIMIT_REGISTER_MAX: '100', RATE_LIMIT_LOGIN_MAX: '100' } as NodeJS.ProcessEnv);

function buildApp() {
  const settings = config();
  const auth = testAuth(db!, settings, new FakePasswordHasher(), silentLogger());
  return { auth, app: testApp({ config: settings, auth }) };
}

/** Registers an account and returns its cookie and id. */
async function account(
  app: ReturnType<typeof buildApp>['app'],
  name: string,
): Promise<{ cookie: string; id: string }> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({
      email: `${name}@example.test`,
      username: name,
      password: 'analytical-engine-1843',
    })
    .expect(201);

  const header = res.headers['set-cookie'] as unknown as string[];
  return {
    cookie: header.find((c) => c.startsWith('platform_session='))!.split(';')[0]!,
    id: res.body.user.id,
  };
}

const projects = () => new ProjectRepository(db!);

/** Creates a project, failing the test if the slug collided. */
async function makeProject(input: {
  slug: string;
  name: string;
  ownerId: string;
}): Promise<{ id: string }> {
  const result = await projects().create(input);
  if (!result.ok) throw new Error(`could not create project: ${result.conflict} conflict`);
  return result.project;
}

afterAll(async () => {
  await db?.$disconnect();
});

describe.skipIf(!db)('project creation invariants', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('gives the owner an OWNER membership in the same transaction', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');

    const project = await makeProject({ slug: 'engine', name: 'Engine', ownerId: ada.id });

    // Without this the project would be unreachable by everyone, including the
    // person who made it, because access checks read memberships only.
    const membership = await projects().findMembership(project.id, ada.id);
    expect(membership?.role).toBe('OWNER');
  });

  it('rolls the project back if the membership cannot be written', async () => {
    const { app } = buildApp();
    await account(app, 'ada');

    await expect(
      projects().create({
        slug: 'orphan',
        name: 'Orphan',
        ownerId: '00000000-0000-7000-8000-000000000000',
      }),
    ).rejects.toThrow();

    expect(await db!.project.count()).toBe(0);
  });

  it('scopes the slug to the owner, so two people may both have one named the same', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const grace = await account(app, 'grace');

    await makeProject({ slug: 'api', name: 'API', ownerId: ada.id });
    await expect(
      makeProject({ slug: 'api', name: 'API', ownerId: grace.id }),
    ).resolves.toBeDefined();
  });

  it('refuses the same slug twice for one owner', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');

    await makeProject({ slug: 'api', name: 'API', ownerId: ada.id });

    // A collision is a typed outcome, not an exception. Two concurrent
    // requests reaching here is normal, and the caller decides what to do
    // about it.
    const second = await projects().create({ slug: 'api', name: 'API', ownerId: ada.id });
    expect(second).toEqual({ ok: false, conflict: 'slug' });
  });

  it('cannot hold two roles for one person on one project', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const project = await makeProject({ slug: 'api', name: 'API', ownerId: ada.id });

    // Two rows could disagree, and whichever the query returned first would
    // decide access.
    await expect(
      db!.projectMember.create({ data: { projectId: project.id, userId: ada.id, role: 'VIEWER' } }),
    ).rejects.toThrow();
  });

  it('removes memberships when the project is deleted', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const project = await makeProject({ slug: 'api', name: 'API', ownerId: ada.id });

    await db!.project.delete({ where: { id: project.id } });
    expect(await db!.projectMember.count()).toBe(0);
  });

  it('removes projects when the owner is deleted', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    await makeProject({ slug: 'api', name: 'API', ownerId: ada.id });

    await db!.user.delete({ where: { id: ada.id } });
    expect(await db!.project.count()).toBe(0);
  });
});

describe.skipIf(!db)('GET /api/projects/:id/members', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('refuses an anonymous caller', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const project = await makeProject({ slug: 'api', name: 'API', ownerId: ada.id });

    const res = await request(app).get(`/api/projects/${project.id}/members`).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('lets the owner list members', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const project = await makeProject({ slug: 'api', name: 'API', ownerId: ada.id });

    const res = await request(app)
      .get(`/api/projects/${project.id}/members`)
      .set('Cookie', ada.cookie)
      .expect(200);

    expect(() => projectMembersResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.members).toHaveLength(1);
    expect(res.body.members[0].username).toBe('ada');
    expect(res.body.members[0].role).toBe('OWNER');
  });

  it('hides another user project behind a 404, not a 403', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const stranger = await account(app, 'stranger');
    const project = await makeProject({ slug: 'api', name: 'API', ownerId: ada.id });

    const res = await request(app)
      .get(`/api/projects/${project.id}/members`)
      .set('Cookie', stranger.cookie)
      .expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('answers identically for a real project and one that does not exist', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const stranger = await account(app, 'stranger');
    const project = await makeProject({ slug: 'api', name: 'API', ownerId: ada.id });

    const real = await request(app)
      .get(`/api/projects/${project.id}/members`)
      .set('Cookie', stranger.cookie)
      .expect(404);

    const imaginary = await request(app)
      .get('/api/projects/00000000-0000-7000-8000-000000000000/members')
      .set('Cookie', stranger.cookie)
      .expect(404);

    // Otherwise anyone could walk identifiers and learn which projects exist.
    // The request id differs by design; everything an attacker could read is
    // the same.
    expect(imaginary.body.error.code).toBe(real.body.error.code);
    expect(imaginary.body.error.message).toBe(real.body.error.message);
    expect(imaginary.body.error.details).toEqual(real.body.error.details);
    expect(Object.keys(imaginary.body.error).sort()).toEqual(Object.keys(real.body.error).sort());
  });

  it('answers a malformed identifier the same way', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');

    const res = await request(app)
      .get('/api/projects/not-a-uuid/members')
      .set('Cookie', ada.cookie)
      .expect(404);

    // Probing with junk must not be distinguishable from probing with a real
    // identifier belonging to someone else.
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('lets an invited viewer see the member list', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const grace = await account(app, 'grace');
    const project = await makeProject({ slug: 'api', name: 'API', ownerId: ada.id });

    await projects().upsertMembership(project.id, grace.id, 'VIEWER');

    const res = await request(app)
      .get(`/api/projects/${project.id}/members`)
      .set('Cookie', grace.cookie)
      .expect(200);

    expect(res.body.members).toHaveLength(2);
  });

  it('reports the caller own capabilities, not the owner ones', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const grace = await account(app, 'grace');
    const project = await makeProject({ slug: 'api', name: 'API', ownerId: ada.id });
    await projects().upsertMembership(project.id, grace.id, 'VIEWER');

    const asViewer = await request(app)
      .get(`/api/projects/${project.id}/members`)
      .set('Cookie', grace.cookie)
      .expect(200);

    expect(asViewer.body.viewerPermissions).toContain('file:read');
    expect(asViewer.body.viewerPermissions).not.toContain('file:write');
    expect(asViewer.body.viewerPermissions).not.toContain('secret:read');

    const asOwner = await request(app)
      .get(`/api/projects/${project.id}/members`)
      .set('Cookie', ada.cookie)
      .expect(200);

    expect(asOwner.body.viewerPermissions).toContain('member:manage');
  });

  it('loses access the moment membership is revoked', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const grace = await account(app, 'grace');
    const project = await makeProject({ slug: 'api', name: 'API', ownerId: ada.id });
    await projects().upsertMembership(project.id, grace.id, 'EDITOR');

    await request(app)
      .get(`/api/projects/${project.id}/members`)
      .set('Cookie', grace.cookie)
      .expect(200);

    await projects().removeMembership(project.id, grace.id);

    // No cached decision anywhere: the next request re-reads the membership.
    await request(app)
      .get(`/api/projects/${project.id}/members`)
      .set('Cookie', grace.cookie)
      .expect(404);
  });

  it('never exposes another member email address', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const grace = await account(app, 'grace');
    const project = await makeProject({ slug: 'api', name: 'API', ownerId: ada.id });
    await projects().upsertMembership(project.id, grace.id, 'VIEWER');

    const res = await request(app)
      .get(`/api/projects/${project.id}/members`)
      .set('Cookie', grace.cookie)
      .expect(200);

    expect(JSON.stringify(res.body)).not.toContain('@example.test');
  });

  it('lists owners before other members', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const grace = await account(app, 'grace');
    const project = await makeProject({ slug: 'api', name: 'API', ownerId: ada.id });
    await projects().upsertMembership(project.id, grace.id, 'EDITOR');

    const res = await request(app)
      .get(`/api/projects/${project.id}/members`)
      .set('Cookie', ada.cookie)
      .expect(200);

    expect(res.body.members[0].role).toBe('OWNER');
  });
});

describe.skipIf(!db)('role changes take effect immediately', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  const roles: ProjectRole[] = ['VIEWER', 'EDITOR', 'OWNER'];

  it('a promotion widens what the caller may do on the next request', async () => {
    const { app, auth } = buildApp();
    const ada = await account(app, 'ada');
    const grace = await account(app, 'grace');
    const project = await makeProject({ slug: 'api', name: 'API', ownerId: ada.id });

    const authorization = new AuthorizationService(auth.projects);

    for (const role of roles) {
      await projects().upsertMembership(project.id, grace.id, role);

      expect(await authorization.can(grace.id, project.id, 'file:read')).toBe(true);
      expect(await authorization.can(grace.id, project.id, 'file:write')).toBe(role !== 'VIEWER');
      expect(await authorization.can(grace.id, project.id, 'member:manage')).toBe(role === 'OWNER');
    }
  });

  it('a project the user was never in is invisible at every role', async () => {
    const { app, auth } = buildApp();
    const ada = await account(app, 'ada');
    const stranger = await account(app, 'stranger');
    const project = await makeProject({ slug: 'api', name: 'API', ownerId: ada.id });

    const authorization = new AuthorizationService(auth.projects);
    expect(await authorization.can(stranger.id, project.id, 'project:read')).toBe(false);
  });
});

describe.skipIf(!db)('listing a user projects', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('includes owned and shared projects, and nothing else', async () => {
    const { app } = buildApp();
    const ada = await account(app, 'ada');
    const grace = await account(app, 'grace');

    const mine = await makeProject({ slug: 'mine', name: 'Mine', ownerId: ada.id });
    const shared = await makeProject({ slug: 'shared', name: 'Shared', ownerId: grace.id });
    await makeProject({ slug: 'theirs', name: 'Theirs', ownerId: grace.id });
    await projects().upsertMembership(shared.id, ada.id, 'VIEWER');

    const visible = await projects().listForUser(ada.id);
    expect(visible.map((p) => p.id).sort()).toEqual([mine.id, shared.id].sort());
  });
});
