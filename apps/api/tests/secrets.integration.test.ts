import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { secretListResponseSchema } from '@platform/shared';
import { loadEnv } from '../src/config/env.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import { RecordingExecutionProvider } from './setup/execution.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * Project secrets over real HTTP against the real database.
 *
 * The thing being checked throughout is a negative: that no path through this
 * API returns a value. The positive case, that a container receives them, is
 * checked at the end through what the provider was asked to create.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

const KEY = randomBytes(32).toString('base64');

function buildApp(overrides: Record<string, string> = {}) {
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_PROJECT_CREATE_MAX: '100',
    RATE_LIMIT_RUNTIME_CONTROL_MAX: '100',
    SECRETS_ENCRYPTION_KEY: KEY,
    ...overrides,
  } as NodeJS.ProcessEnv);

  const provider = new RecordingExecutionProvider();
  const auth = testAuth(db!, config, new FakePasswordHasher(), silentLogger(), provider);
  return { provider, app: testApp({ config, auth }) };
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
    .send({ name: 'Secrets' })
    .expect(201);
  const projectId = created.body.project.id as string;

  const base = `/api/projects/${projectId}/secrets`;

  return {
    ...built,
    cookie,
    projectId,
    set: (key: string, value: string) =>
      request(built.app).put(base).set('Cookie', cookie).send({ key, value }),
    list: () => request(built.app).get(base).set('Cookie', cookie),
    remove: (key: string) =>
      request(built.app)
        .delete(`${base}/${encodeURIComponent(key)}`)
        .set('Cookie', cookie),
  };
}

describe.skipIf(!db)('project secrets', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  describe('setting and listing', () => {
    it('stores a value and lists its name', async () => {
      const harness = await workspace();
      await harness.set('API_TOKEN', 'sk-live-abc123').expect(200);

      const listed = secretListResponseSchema.parse((await harness.list().expect(200)).body);

      expect(listed.secrets.map((secret) => secret.key)).toEqual(['API_TOKEN']);
      expect(listed.secrets[0]?.length).toBe(14);
    });

    it('never returns the value, anywhere', async () => {
      // The single property this whole feature exists to have.
      const harness = await workspace();
      const secret = 'sk-live-do-not-leak-this';
      const setResponse = await harness.set('API_TOKEN', secret).expect(200);

      expect(JSON.stringify(setResponse.body)).not.toContain(secret);

      const listResponse = await harness.list().expect(200);
      expect(JSON.stringify(listResponse.body)).not.toContain(secret);
    });

    it('returns no hint of the value either', async () => {
      // A prefix or a last-four is a way to confirm a guess.
      const harness = await workspace();
      await harness.set('API_TOKEN', 'sk-live-abcdef').expect(200);

      const body = JSON.stringify((await harness.list().expect(200)).body);
      for (const fragment of ['sk-', 'live', 'abcdef', 'cdef']) {
        expect(body).not.toContain(fragment);
      }
    });

    it('replaces a value that is set again', async () => {
      const harness = await workspace();
      await harness.set('API_TOKEN', 'first').expect(200);
      await harness.set('API_TOKEN', 'second-value').expect(200);

      const listed = secretListResponseSchema.parse((await harness.list().expect(200)).body);
      expect(listed.secrets).toHaveLength(1);
      expect(listed.secrets[0]?.length).toBe(12);
    });

    it('stores the value encrypted, not as text', async () => {
      // Read straight from the table, because this is a claim about what is on
      // disk rather than about what an endpoint returns.
      const harness = await workspace();
      await harness.set('API_TOKEN', 'plaintext-would-be-here').expect(200);

      const row = await db!.projectSecret.findFirstOrThrow();
      expect(Buffer.from(row.value).toString('utf8')).not.toContain('plaintext-would-be-here');
    });
  });

  describe('what a name may be', () => {
    it('refuses a name a shell could not use', async () => {
      const harness = await workspace();

      for (const key of ['lower_case', '1LEADING', 'HAS-DASH', 'HAS SPACE', 'HAS.DOT', '']) {
        await harness.set(key, 'x').expect(422);
      }
    });

    it('refuses names that change how a process loads code', async () => {
      // The container is isolated either way. This is about a runtime that
      // behaves predictably rather than about protecting the platform.
      const harness = await workspace();

      for (const key of ['PATH', 'LD_PRELOAD', 'HOME', 'BASH_ENV']) {
        const res = await harness.set(key, '/tmp/evil').expect(422);
        expect(JSON.stringify(res.body)).toContain('reserved');
      }
    });

    it('accepts the names a project actually uses', async () => {
      const harness = await workspace();

      for (const key of ['DATABASE_URL', 'API_KEY', '_INTERNAL', 'PORT2']) {
        await harness.set(key, 'value').expect(200);
      }
    });

    it('refuses an empty value', async () => {
      const harness = await workspace();
      await harness.set('API_TOKEN', '').expect(422);
    });

    it('never repeats the value back in a validation error', async () => {
      const harness = await workspace();
      const res = await harness.set('lower', 'sk-live-secret').expect(422);
      expect(JSON.stringify(res.body)).not.toContain('sk-live-secret');
    });
  });

  describe('limits', () => {
    it('bounds how many one project may hold', async () => {
      const harness = await workspace({ MAX_SECRETS_PER_PROJECT: '2' });
      await harness.set('ONE', 'a').expect(200);
      await harness.set('TWO', 'b').expect(200);

      await harness.set('THREE', 'c').expect(413);
    });

    it('still allows an existing one to be replaced at the limit', async () => {
      const harness = await workspace({ MAX_SECRETS_PER_PROJECT: '2' });
      await harness.set('ONE', 'a').expect(200);
      await harness.set('TWO', 'b').expect(200);

      await harness.set('ONE', 'changed').expect(200);
    });
  });

  describe('removing', () => {
    it('removes a secret', async () => {
      const harness = await workspace();
      await harness.set('API_TOKEN', 'x').expect(200);

      await harness.remove('API_TOKEN').expect(204);

      const listed = secretListResponseSchema.parse((await harness.list().expect(200)).body);
      expect(listed.secrets).toEqual([]);
    });

    it('refuses to remove one that is not there', async () => {
      const harness = await workspace();
      await harness.remove('NOT_SET').expect(404);
    });
  });

  describe('who may touch them', () => {
    it('refuses an anonymous caller', async () => {
      const harness = await workspace();
      await request(harness.app).get(`/api/projects/${harness.projectId}/secrets`).expect(401);
    });

    it('hides another account project behind a not found', async () => {
      const harness = await workspace();
      const intruder = await account(harness.app, 'mallory');

      await request(harness.app)
        .get(`/api/projects/${harness.projectId}/secrets`)
        .set('Cookie', intruder)
        .expect(404);
    });

    it('refuses an editor, who can change the project but not its credentials', async () => {
      const harness = await workspace();
      const editorCookie = await account(harness.app, 'editor');
      const editor = await db!.user.findUniqueOrThrow({ where: { username: 'editor' } });
      await db!.projectMember.create({
        data: { projectId: harness.projectId, userId: editor.id, role: 'EDITOR' },
      });

      await request(harness.app)
        .get(`/api/projects/${harness.projectId}/secrets`)
        .set('Cookie', editorCookie)
        .expect(403);

      await request(harness.app)
        .put(`/api/projects/${harness.projectId}/secrets`)
        .set('Cookie', editorCookie)
        .send({ key: 'SNEAKY', value: 'x' })
        .expect(403);
    });
  });

  describe('with no encryption key configured', () => {
    it('says so rather than storing a value in the clear', async () => {
      const harness = await workspace({ SECRETS_ENCRYPTION_KEY: '' });

      const listed = secretListResponseSchema.parse((await harness.list().expect(200)).body);
      expect(listed.unavailableReason).toContain('no encryption key');
    });

    it('refuses to store one at all', async () => {
      const harness = await workspace({ SECRETS_ENCRYPTION_KEY: '' });
      await harness.set('API_TOKEN', 'x').expect(503);

      expect(await db!.projectSecret.count()).toBe(0);
    });
  });

  describe('reaching the container', () => {
    it('hands the project secrets to the workload it starts', async () => {
      const harness = await workspace();
      await harness.set('API_TOKEN', 'sk-live-abc').expect(200);
      await harness.set('DATABASE_URL', 'postgres://x').expect(200);

      await request(harness.app)
        .put(`/api/projects/${harness.projectId}/files/content`)
        .set('Cookie', harness.cookie)
        .send({ path: 'package.json', content: '{}', encoding: 'utf8' })
        .expect(200);

      await request(harness.app)
        .post(`/api/projects/${harness.projectId}/runtime/start`)
        .set('Cookie', harness.cookie)
        .send({})
        .expect(200);

      expect(harness.provider.created[0]?.env).toEqual({
        API_TOKEN: 'sk-live-abc',
        DATABASE_URL: 'postgres://x',
      });
    });

    it('hands it nothing else', async () => {
      // Platform configuration and database credentials are not in scope where
      // this is assembled, and this is what says so.
      const harness = await workspace();

      await request(harness.app)
        .put(`/api/projects/${harness.projectId}/files/content`)
        .set('Cookie', harness.cookie)
        .send({ path: 'package.json', content: '{}', encoding: 'utf8' })
        .expect(200);

      await request(harness.app)
        .post(`/api/projects/${harness.projectId}/runtime/start`)
        .set('Cookie', harness.cookie)
        .send({})
        .expect(200);

      expect(harness.provider.created[0]?.env).toEqual({});
    });
  });
});
