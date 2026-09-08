import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { AlertRepository } from '../src/modules/alerts/alert.repository.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/** Alert settings through the real stack, and the claim that stops two workers emailing twice. */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

async function setUp() {
  const hasher = new FakePasswordHasher();
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_PROJECT_CREATE_MAX: '100',
  } as NodeJS.ProcessEnv);
  const auth = testAuth(db!, config, hasher, silentLogger());
  const app = testApp({ config, passwordHasher: hasher, auth });

  const register = async (name: string) => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: `${name}@example.test`, username: name, password: 'analytical-engine-1843' })
      .expect(201);
    return (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  };

  const owner = await register('ada');
  const viewer = await register('grace');
  const project = await request(app)
    .post('/api/projects')
    .set('Cookie', owner)
    .send({ name: 'Shop' })
    .expect(201);
  const projectId = project.body.project.id as string;
  const grace = await db!.user.findUniqueOrThrow({ where: { username: 'grace' } });
  await db!.projectMember.create({ data: { projectId, userId: grace.id, role: 'VIEWER' } });

  return { app, auth, owner, viewer, projectId };
}

afterAll(async () => {
  await db?.$disconnect();
});

describe.skipIf(!db)('alert settings', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('starts off, and says why an alert would not be delivered', async () => {
    const { app, owner, projectId } = await setUp();
    const res = await request(app)
      .get(`/api/projects/${projectId}/alerts`)
      .set('Cookie', owner)
      .expect(200);

    expect(res.body.settings).toEqual({
      enabled: false,
      failuresBeforeAlert: 3,
      memoryPercent: null,
    });
    expect(res.body.firing).toEqual([]);
    // The test installation has no mail server, and says so rather than pretending.
    expect(res.body.deliveryProblem).toMatch(/cannot send email/);
  });

  it('lets the owner turn alerts on, and resets their state when changed', async () => {
    const { app, owner, projectId } = await setUp();
    await db!.projectAlertSettings.create({
      data: { projectId, enabled: true, consecutiveFailures: 2, healthFiring: true },
    });

    const res = await request(app)
      .put(`/api/projects/${projectId}/alerts`)
      .set('Cookie', owner)
      .send({ enabled: true, failuresBeforeAlert: 5, memoryPercent: 90 })
      .expect(200);

    expect(res.body.settings).toEqual({ enabled: true, failuresBeforeAlert: 5, memoryPercent: 90 });
    expect(res.body.firing).toEqual([]);
    const row = await db!.projectAlertSettings.findUniqueOrThrow({ where: { projectId } });
    expect(row.consecutiveFailures).toBe(0);
  });

  it('lets a viewer see alerts but not decide what the owner is emailed', async () => {
    const { app, viewer, projectId } = await setUp();
    await request(app).get(`/api/projects/${projectId}/alerts`).set('Cookie', viewer).expect(200);
    await request(app)
      .put(`/api/projects/${projectId}/alerts`)
      .set('Cookie', viewer)
      .send({ enabled: true, failuresBeforeAlert: 3, memoryPercent: null })
      .expect(403);
  });

  it('refuses thresholds that are not warnings', async () => {
    const { app, owner, projectId } = await setUp();
    for (const body of [
      { enabled: true, failuresBeforeAlert: 0, memoryPercent: null },
      { enabled: true, failuresBeforeAlert: 3, memoryPercent: 10 },
      { enabled: true, failuresBeforeAlert: 3, memoryPercent: 101 },
    ]) {
      await request(app)
        .put(`/api/projects/${projectId}/alerts`)
        .set('Cookie', owner)
        .send(body)
        .expect(422);
    }
  });

  it('checks a project with nothing deployed without inventing an alert', async () => {
    const { app, auth, owner, projectId } = await setUp();
    await request(app)
      .put(`/api/projects/${projectId}/alerts`)
      .set('Cookie', owner)
      .send({ enabled: true, failuresBeforeAlert: 1, memoryPercent: 50 })
      .expect(200);

    expect(await auth.alerts.evaluate()).toBe(1);
    const res = await request(app)
      .get(`/api/projects/${projectId}/alerts`)
      .set('Cookie', owner)
      .expect(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.lastCheckedAt).not.toBeNull();

    // Just checked, so not due again yet.
    expect(await auth.alerts.evaluate()).toBe(0);
  });
});

describe.skipIf(!db)('claiming projects to check', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('hands each due project to exactly one of several workers', async () => {
    const { projectId } = await setUp();
    await db!.projectAlertSettings.create({ data: { projectId, enabled: true } });
    const repository = new AlertRepository(db! as never);

    const claims = await Promise.all(
      Array.from({ length: 8 }, () => repository.claimDue(60_000, 10)),
    );
    expect(claims.flat()).toHaveLength(1);
  });

  it('skips projects with alerts turned off', async () => {
    const { projectId } = await setUp();
    await db!.projectAlertSettings.create({ data: { projectId, enabled: false } });
    expect(await new AlertRepository(db! as never).claimDue(0, 10)).toEqual([]);
  });
});
