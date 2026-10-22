import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { rotateSecrets } from '../src/lifecycle/rotate-secrets.js';
import { createKeyRing } from '../src/lib/secret-box.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import { RecordingExecutionProvider } from './setup/execution.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * Rotating the encryption key, start to finish, against the real database.
 *
 * The property that matters: after the rotation, the old key can be thrown away
 * and every secret is still readable — proved by reading them with a platform
 * that has never heard of the old key.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

const OLD = randomBytes(32).toString('base64');
const NEW = randomBytes(32).toString('base64');

afterAll(async () => {
  await db?.$disconnect();
});

function platform(keys: { current: string; previous?: string }) {
  const hasher = new FakePasswordHasher();
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_PROJECT_CREATE_MAX: '100',
    RATE_LIMIT_RUNTIME_CONTROL_MAX: '100',
    SECRETS_ENCRYPTION_KEY: keys.current,
    ...(keys.previous ? { SECRETS_PREVIOUS_KEYS: keys.previous } : {}),
  } as NodeJS.ProcessEnv);
  const provider = new RecordingExecutionProvider();
  const auth = testAuth(db!, config, hasher, silentLogger(), provider);
  return { app: testApp({ config, passwordHasher: hasher, auth }), provider };
}

describe.skipIf(!db)('rotating the secrets encryption key', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('keeps every secret readable after the old key is gone', async () => {
    // Before: everything sealed with the old key.
    const before = platform({ current: OLD });
    const res = await request(before.app)
      .post('/api/auth/register')
      .send({ email: 'ada@example.test', username: 'ada', password: 'analytical-engine-1843' })
      .expect(201);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const project = await request(before.app)
      .post('/api/projects')
      .set('Cookie', cookie)
      .send({ name: 'Keys' })
      .expect(201);
    const projectId = project.body.project.id as string;
    await request(before.app)
      .put(`/api/projects/${projectId}/secrets`)
      .set('Cookie', cookie)
      .send({ key: 'API_TOKEN', value: 'sealed-with-the-old-key' })
      .expect(200);

    // Rotate: new key current, old key only for reading.
    const ring = createKeyRing(Buffer.from(NEW, 'base64'), [Buffer.from(OLD, 'base64')]);
    const first = await rotateSecrets(db!, ring, silentLogger());
    expect(first.secrets).toEqual({ resealed: 1, alreadyCurrent: 0, unreadable: 0 });

    // Safe to run again.
    const second = await rotateSecrets(db!, ring, silentLogger());
    expect(second.secrets).toEqual({ resealed: 0, alreadyCurrent: 1, unreadable: 0 });

    // After: a platform that has never heard of the old key hands the secret to
    // a container intact — the only place a secret is ever decrypted.
    const after = platform({ current: NEW });
    await request(after.app)
      .put(`/api/projects/${projectId}/files/content`)
      .set('Cookie', cookie)
      .send({ path: 'index.js', content: 'console.log(1)', encoding: 'utf8' })
      .expect(200);
    await request(after.app)
      .post(`/api/projects/${projectId}/runtime/start`)
      .set('Cookie', cookie)
      .send({})
      .expect(200);

    expect(after.provider.created.at(-1)?.env.API_TOKEN).toBe('sealed-with-the-old-key');
  });

  it('reports what it could not open, rather than skipping it silently', async () => {
    await db!.user.create({
      data: {
        id: '018f0000-0000-7000-8000-000000000001',
        email: 'x@example.test',
        username: 'x',
        passwordHash: 'x',
      },
    });
    const project = await db!.project.create({
      data: { slug: 'p', name: 'P', ownerId: '018f0000-0000-7000-8000-000000000001' },
    });
    await db!.projectSecret.create({
      data: {
        projectId: project.id,
        key: 'ORPHANED',
        value: Buffer.from(randomBytes(48)),
        length: 1,
      },
    });

    const ring = createKeyRing(Buffer.from(NEW, 'base64'), [Buffer.from(OLD, 'base64')]);
    const report = await rotateSecrets(db!, ring, silentLogger());
    expect(report.secrets.unreadable).toBe(1);
  });

  it('reseals two-factor secrets and git tokens too', async () => {
    const oldRing = createKeyRing(Buffer.from(OLD, 'base64'));
    const user = await db!.user.create({
      data: {
        email: 'y@example.test',
        username: 'y',
        passwordHash: 'x',
        totpSecret: new Uint8Array(oldRing.seal('totp-seed')),
      },
    });
    const project = await db!.project.create({ data: { slug: 'g', name: 'G', ownerId: user.id } });
    await db!.projectGitRemote.create({
      data: {
        projectId: project.id,
        url: 'https://example.test/repo.git',
        token: new Uint8Array(oldRing.seal('ghp_token')),
      },
    });

    const ring = createKeyRing(Buffer.from(NEW, 'base64'), [Buffer.from(OLD, 'base64')]);
    const report = await rotateSecrets(db!, ring, silentLogger());
    expect(report.twoFactor).toEqual({ resealed: 1, alreadyCurrent: 0, unreadable: 0 });
    expect(report.gitRemotes).toEqual({ resealed: 1, alreadyCurrent: 0, unreadable: 0 });

    // Readable with the new key alone.
    const newOnly = createKeyRing(Buffer.from(NEW, 'base64'));
    const after = await db!.user.findUniqueOrThrow({ where: { id: user.id } });
    const remote = await db!.projectGitRemote.findUniqueOrThrow({
      where: { projectId: project.id },
    });
    expect(newOnly.open(after.totpSecret!)).toBe('totp-seed');
    expect(newOnly.open(remote.token!)).toBe('ghp_token');
  });
});
