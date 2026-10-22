import request from 'supertest';
import { pino } from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ASSET_NAME_HEADER, assetListResponseSchema } from '@platform/shared';
import { loadEnv } from '../src/config/env.js';
import { MinioStorageProvider } from '../src/storage/minio-storage.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * Project assets, over real HTTP against the real object store.
 *
 * MinIO runs in this platform's own compose file, so this suite uses it rather
 * than a double: what is being checked is that bytes come back exactly as they
 * went in, and a double that returns what it was given proves nothing about
 * that.
 *
 * Skips when the store is not configured, rather than passing against nothing.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

const storageConfigured =
  Boolean(process.env.STORAGE_ENDPOINT) &&
  Boolean(process.env.STORAGE_ACCESS_KEY) &&
  Boolean(process.env.STORAGE_SECRET_KEY);

// A bucket of its own, created on demand, so a test run never disturbs what a
// developer has been storing.
const BUCKET = 'platform-assets-test';

function buildApp(overrides: Record<string, string> = {}) {
  const config = loadEnv({
    ...process.env,
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_PROJECT_CREATE_MAX: '100',
    STORAGE_BUCKET: BUCKET,
    ...overrides,
  } as NodeJS.ProcessEnv);

  const storage = new MinioStorageProvider(
    {
      endpoint: config.STORAGE_ENDPOINT!,
      bucket: BUCKET,
      accessKey: config.STORAGE_ACCESS_KEY!,
      secretKey: config.STORAGE_SECRET_KEY!,
      availabilityTtlMs: 0,
    },
    pino({ level: 'silent' }),
  );

  const auth = testAuth(db!, config, new FakePasswordHasher(), silentLogger(), undefined, storage);
  return { app: testApp({ config, auth }), storage };
}

type App = ReturnType<typeof buildApp>['app'];

async function account(app: App, name: string): Promise<string> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: `${name}@example.test`, username: name, password: 'analytical-engine-1843' })
    .expect(201);

  const header = res.headers['set-cookie'] as unknown as string[];
  return header.find((c) => c.startsWith('platform_session='))!.split(';')[0]!;
}

async function workspace(overrides: Record<string, string> = {}) {
  const built = buildApp(overrides);
  const cookie = await account(built.app, 'ada');

  const created = await request(built.app)
    .post('/api/projects')
    .set('Cookie', cookie)
    .send({ name: 'Assets' })
    .expect(201);
  const projectId = created.body.project.id as string;

  const base = `/api/projects/${projectId}/assets`;

  return {
    ...built,
    cookie,
    projectId,
    upload: (name: string, body: Buffer | string, contentType = 'application/octet-stream') =>
      request(built.app)
        .post(base)
        .set('Cookie', cookie)
        .set(ASSET_NAME_HEADER, name)
        .set('Content-Type', contentType)
        .send(body as Buffer),
    list: () => request(built.app).get(base).set('Cookie', cookie),
    download: (id: string) => request(built.app).get(`${base}/${id}/content`).set('Cookie', cookie),
    remove: (id: string) => request(built.app).delete(`${base}/${id}`).set('Cookie', cookie),
  };
}

describe.skipIf(!db || !storageConfigured)('project assets', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  describe('uploading', () => {
    it('stores a file and lists it', async () => {
      const harness = await workspace();

      const uploaded = await harness.upload('notes.txt', 'hello there', 'text/plain').expect(201);
      expect(uploaded.body.asset.name).toBe('notes.txt');

      const listed = assetListResponseSchema.parse((await harness.list().expect(200)).body);
      expect(listed.assets.map((asset) => asset.name)).toEqual(['notes.txt']);
      expect(listed.totalBytes).toBe(11);
    });

    it('returns the bytes exactly as they went in', async () => {
      // The one claim a stand-in for the object store could not support.
      const harness = await workspace();
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x00, 0x01]);

      const uploaded = await harness.upload('logo.png', bytes, 'image/png').expect(201);
      const downloaded = await harness.download(uploaded.body.asset.id).expect(200);

      expect(Buffer.from(downloaded.body)).toEqual(bytes);
    });

    it('records a checksum a caller can compare against', async () => {
      const harness = await workspace();
      const first = await harness.upload('a.txt', 'same bytes').expect(201);
      const second = await harness.upload('b.txt', 'same bytes').expect(201);

      expect(second.body.asset.checksum).toBe(first.body.asset.checksum);
    });

    it('refuses an upload with no name', async () => {
      const harness = await workspace();

      await request(harness.app)
        .post(`/api/projects/${harness.projectId}/assets`)
        .set('Cookie', harness.cookie)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('x'))
        .expect(400);
    });

    it('refuses a name that is a path', async () => {
      // The storage key is generated, so this cannot escape anything. It is
      // refused because a name that looks like a path will eventually be
      // treated as one by something downstream.
      const harness = await workspace();

      for (const name of ['../escape.txt', 'a/b.txt', 'a\\b.txt']) {
        await harness.upload(name, 'x').expect(422);
      }
    });

    it('refuses an empty file', async () => {
      const harness = await workspace();
      await harness.upload('empty.txt', Buffer.alloc(0)).expect(400);
    });

    it('refuses a file over the single-file limit', async () => {
      const harness = await workspace({ ASSET_MAX_BYTES: '2048' });
      await harness.upload('big.bin', Buffer.alloc(4096, 1)).expect(413);
    });

    it('refuses an upload that would exceed the project total', async () => {
      const harness = await workspace({ PROJECT_ASSET_MAX_BYTES: '4096' });
      await harness.upload('a.bin', Buffer.alloc(3000, 1)).expect(201);

      await harness.upload('b.bin', Buffer.alloc(3000, 1)).expect(413);
      const listed = assetListResponseSchema.parse((await harness.list().expect(200)).body);
      expect(listed.assets).toHaveLength(1);
    });

    it('reduces a content type to something safe to store', async () => {
      const harness = await workspace();
      const uploaded = await harness.upload('x.txt', 'x', 'text/html; charset=utf-8').expect(201);

      // Parameters dropped: the stored value cannot carry a second type or a
      // header injection.
      expect(uploaded.body.asset.contentType).toBe('text/html');
    });
  });

  describe('downloading', () => {
    it('never lets an upload render on the platform origin', async () => {
      // A file claiming to be an image and containing a page would otherwise
      // run as whoever opened it, with their session.
      const harness = await workspace();
      const uploaded = await harness
        .upload('trap.html', '<script>alert(1)</script>', 'text/html')
        .expect(201);

      const response = await harness.download(uploaded.body.asset.id).expect(200);

      expect(response.headers['content-type']).toBe('application/octet-stream');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    });

    it('keeps a hostile file name out of the header', async () => {
      const harness = await workspace();
      const uploaded = await harness.upload('a"; drop=1; x="b.txt', 'x').expect(201);

      const response = await harness.download(uploaded.body.asset.id).expect(200);
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="a_; drop=1; x=_b.txt"',
      );
    });

    it('refuses an identifier from another project', async () => {
      const harness = await workspace();
      const uploaded = await harness.upload('mine.txt', 'x').expect(201);

      const other = await request(harness.app)
        .post('/api/projects')
        .set('Cookie', harness.cookie)
        .send({ name: 'Other' })
        .expect(201);

      await request(harness.app)
        .get(`/api/projects/${other.body.project.id}/assets/${uploaded.body.asset.id}/content`)
        .set('Cookie', harness.cookie)
        .expect(404);
    });
  });

  describe('deleting', () => {
    it('removes the file from the listing', async () => {
      const harness = await workspace();
      const uploaded = await harness.upload('gone.txt', 'x').expect(201);

      await harness.remove(uploaded.body.asset.id).expect(204);

      const listed = assetListResponseSchema.parse((await harness.list().expect(200)).body);
      expect(listed.assets).toEqual([]);
      await harness.download(uploaded.body.asset.id).expect(404);
    });

    it('gives the space back', async () => {
      const harness = await workspace();
      const uploaded = await harness.upload('a.bin', Buffer.alloc(1000, 1)).expect(201);
      await harness.remove(uploaded.body.asset.id).expect(204);

      const listed = assetListResponseSchema.parse((await harness.list().expect(200)).body);
      expect(listed.totalBytes).toBe(0);
    });

    it('refuses to delete something that is not there', async () => {
      const harness = await workspace();
      await harness.remove('018f0000-0000-7000-8000-0000000000ff').expect(404);
    });
  });

  describe('access', () => {
    it('refuses an anonymous caller', async () => {
      const harness = await workspace();
      await request(harness.app).get(`/api/projects/${harness.projectId}/assets`).expect(401);
    });

    it('hides another account project behind a not found', async () => {
      const harness = await workspace();
      const intruder = await account(harness.app, 'mallory');

      await request(harness.app)
        .get(`/api/projects/${harness.projectId}/assets`)
        .set('Cookie', intruder)
        .expect(404);
    });

    it('lets a viewer read but not upload', async () => {
      const harness = await workspace();
      const viewerCookie = await account(harness.app, 'viewer');
      const viewer = await db!.user.findUniqueOrThrow({ where: { username: 'viewer' } });
      await db!.projectMember.create({
        data: { projectId: harness.projectId, userId: viewer.id, role: 'VIEWER' },
      });

      await request(harness.app)
        .get(`/api/projects/${harness.projectId}/assets`)
        .set('Cookie', viewerCookie)
        .expect(200);

      await request(harness.app)
        .post(`/api/projects/${harness.projectId}/assets`)
        .set('Cookie', viewerCookie)
        .set(ASSET_NAME_HEADER, 'nope.txt')
        .set('Content-Type', 'text/plain')
        .send(Buffer.from('x'))
        .expect(403);
    });
  });
});
