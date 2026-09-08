import request from 'supertest';
import { pino } from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { MinioStorageProvider } from '../src/storage/minio-storage.js';
import { UnavailableExecutionProvider } from '../src/execution/unavailable-provider.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * Putting one file back from a snapshot, through the real stack and real object
 * storage. Requires `pnpm infra:up`.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

const storage = new MinioStorageProvider(
  {
    endpoint: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9100',
    bucket: process.env.STORAGE_BUCKET ?? 'platform-assets',
    accessKey: process.env.STORAGE_ACCESS_KEY ?? 'platform',
    secretKey: process.env.STORAGE_SECRET_KEY ?? 'platform_dev_only',
    availabilityTtlMs: 0,
  },
  pino({ level: 'silent' }),
);
const storageUp = (await storage.unavailableReason()) === null;

afterAll(async () => {
  await db?.$disconnect();
});

async function workspace() {
  const hasher = new FakePasswordHasher();
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_PROJECT_CREATE_MAX: '100',
  } as NodeJS.ProcessEnv);
  const auth = testAuth(
    db!,
    config,
    hasher,
    silentLogger(),
    new UnavailableExecutionProvider(),
    storage,
  );
  const app = testApp({ config, passwordHasher: hasher, auth });

  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'ada@example.test', username: 'ada', password: 'analytical-engine-1843' })
    .expect(201);
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  const project = await request(app)
    .post('/api/projects')
    .set('Cookie', cookie)
    .send({ name: 'P' })
    .expect(201);
  const base = `/api/projects/${project.body.project.id}`;

  const write = (path: string, content: string) =>
    request(app)
      .put(`${base}/files/content`)
      .set('Cookie', cookie)
      .send({ path, content, encoding: 'utf8' });
  const read = (path: string) =>
    request(app).get(`${base}/files/content`).query({ path }).set('Cookie', cookie);

  return { app, cookie, base, write, read };
}

describe.skipIf(!db || !storageUp)('putting one file back', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('restores one file from a snapshot, leaves the others alone, and returns what was there', async () => {
    const w = await workspace();
    await w.write('notes.txt', 'the good version').expect(200);
    await w.write('other.txt', 'untouched').expect(200);

    const snapshot = await request(w.app)
      .post(`${w.base}/snapshots`)
      .set('Cookie', w.cookie)
      .send({ name: 'before the mistake' })
      .expect(201);
    const snapshotId = snapshot.body.snapshot.id as string;

    await w.write('notes.txt', 'the mistake').expect(200);
    await w.write('other.txt', 'changed since, and must stay changed').expect(200);

    const res = await request(w.app)
      .post(`${w.base}/snapshots/${snapshotId}/restore-file`)
      .set('Cookie', w.cookie)
      .send({ path: 'notes.txt' })
      .expect(200);

    expect(res.body.previous).toEqual({ content: 'the mistake', encoding: 'utf8' });
    expect((await w.read('notes.txt').expect(200)).body.content).toBe('the good version');
    expect((await w.read('other.txt').expect(200)).body.content).toBe(
      'changed since, and must stay changed',
    );
  });

  it('says plainly when the file is not in the snapshot', async () => {
    const w = await workspace();
    await w.write('a.txt', 'a').expect(200);
    const snapshot = await request(w.app)
      .post(`${w.base}/snapshots`)
      .set('Cookie', w.cookie)
      .send({ name: 'one' })
      .expect(201);

    const res = await request(w.app)
      .post(`${w.base}/snapshots/${snapshot.body.snapshot.id}/restore-file`)
      .set('Cookie', w.cookie)
      .send({ path: 'never-existed.txt' })
      .expect(404);
    expect(res.body.error.message).toContain('not in this snapshot');
  });
});
