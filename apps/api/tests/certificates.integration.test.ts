import request from 'supertest';
import { afterAll, beforeEach, describe, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * The proxy's question during a TLS handshake: should this installation hold a
 * certificate for this hostname? Anything answered "yes" costs a request to a
 * certificate authority, so the answer must be closed.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

afterAll(async () => {
  await db?.$disconnect();
});

describe.skipIf(!db)('certificate authorization', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  async function setUp() {
    const hasher = new FakePasswordHasher();
    const config = loadEnv({
      RATE_LIMIT_REGISTER_MAX: '100',
      PREVIEW_HOST_SUFFIX: 'preview.example.com',
      DEPLOYMENT_HOST_SUFFIX: 'app.example.com',
    } as NodeJS.ProcessEnv);
    const app = testApp({
      config,
      passwordHasher: hasher,
      auth: testAuth(db!, config, hasher, silentLogger()),
    });
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'ada@example.test', username: 'ada', password: 'analytical-engine-1843' })
      .expect(201);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const project = await request(app)
      .post('/api/projects')
      .set('Cookie', cookie)
      .send({ name: 'Certs' })
      .expect(201);
    const ask = (domain: string) => request(app).get('/internal/tls-authorize').query({ domain });
    return { ask, projectId: project.body.project.id as string };
  }

  it('says yes for the preview host of a project that exists', async () => {
    const { ask, projectId } = await setUp();
    await ask(`${projectId}.preview.example.com`).expect(200);
  });

  it('says no for a preview host naming no project, or not a project id at all', async () => {
    const { ask } = await setUp();
    await ask('018f0000-0000-7000-8000-000000000000.preview.example.com').expect(404);
    await ask('anything.preview.example.com').expect(404);
    await ask('a.b.preview.example.com').expect(404);
  });

  it('says no for names the installation has never heard of', async () => {
    const { ask } = await setUp();
    await ask('unknown.app.example.com').expect(404);
    await ask('evil.example.net').expect(404);
  });
});
