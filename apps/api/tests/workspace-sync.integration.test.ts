import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { workspaceSyncResultSchema } from '@platform/shared';
import { loadEnv } from '../src/config/env.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import { RecordingExecutionProvider } from './setup/execution.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * Reading a runtime's files back into the project.
 *
 * The provider is a recording double, so what a container did is decided by
 * the test rather than by a real command. What is under test is the rule set:
 * what replaces what, what is left alone, and what is refused.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

function buildApp(overrides: Record<string, string> = {}) {
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_PROJECT_CREATE_MAX: '100',
    RATE_LIMIT_RUNTIME_CONTROL_MAX: '100',
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

const file = (path: string, text: string) => ({
  path,
  content: new TextEncoder().encode(text),
});

/** A signed-in owner with a running project. */
async function running(overrides: Record<string, string> = {}) {
  const { app, provider } = buildApp(overrides);
  const cookie = await account(app, 'ada');

  const created = await request(app)
    .post('/api/projects')
    .set('Cookie', cookie)
    .send({ name: 'Sync' })
    .expect(201);
  const projectId = created.body.project.id as string;

  const write = (path: string, content: string) =>
    request(app)
      .put(`/api/projects/${projectId}/files/content`)
      .set('Cookie', cookie)
      .send({ path, content, encoding: 'utf8' })
      .expect(200);

  await write('package.json', '{}');

  await request(app)
    .post(`/api/projects/${projectId}/runtime/start`)
    .set('Cookie', cookie)
    .send({})
    .expect(200);

  return {
    app,
    provider,
    cookie,
    projectId,
    write,
    sync: () =>
      request(app).post(`/api/projects/${projectId}/runtime/sync`).set('Cookie', cookie).send({}),
    stop: () =>
      request(app).post(`/api/projects/${projectId}/runtime/stop`).set('Cookie', cookie).send({}),
    read: (path: string) =>
      request(app)
        .get(`/api/projects/${projectId}/files/content`)
        .query({ path })
        .set('Cookie', cookie),
    tree: () => request(app).get(`/api/projects/${projectId}/files`).set('Cookie', cookie),
  };
}

describe.skipIf(!db)('reading a runtime workspace back', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  describe('what it brings back', () => {
    it('brings back a file a command created', async () => {
      const harness = await running();
      harness.provider.workspace = [file('package.json', '{}'), file('generated.ts', 'export {}')];

      const res = await harness.sync().expect(200);
      const result = workspaceSyncResultSchema.parse(res.body);

      expect(result.created).toBe(1);
      expect((await harness.read('generated.ts').expect(200)).body.content).toBe('export {}');
    });

    it('replaces a file a command rewrote', async () => {
      // A formatter is the ordinary case: the container is where the work
      // happened, so for that path it wins.
      const harness = await running();
      harness.provider.workspace = [file('package.json', '{ "name": "formatted" }')];

      const result = workspaceSyncResultSchema.parse((await harness.sync().expect(200)).body);

      expect(result.updated).toBe(1);
      expect((await harness.read('package.json').expect(200)).body.content).toContain('formatted');
    });

    it('counts a file that did not change rather than rewriting it', async () => {
      const harness = await running();
      harness.provider.workspace = [file('package.json', '{}')];

      const result = workspaceSyncResultSchema.parse((await harness.sync().expect(200)).body);

      expect(result.unchanged).toBe(1);
      expect(result.updated).toBe(0);
    });

    it('does not bump the version of a file it did not change', async () => {
      // The editor watches versions to detect a conflicting save. A sync that
      // touched everything would make every open tab report one.
      const harness = await running();
      harness.provider.workspace = [file('package.json', '{}')];

      const before = (await harness.read('package.json').expect(200)).body.entry.version;
      await harness.sync().expect(200);
      const after = (await harness.read('package.json').expect(200)).body.entry.version;

      expect(after).toBe(before);
    });

    it('creates the folders a new nested file needs', async () => {
      const harness = await running();
      harness.provider.workspace = [file('package.json', '{}'), file('src/lib/deep.ts', 'x')];

      await harness.sync().expect(200);

      const paths = (await harness.tree().expect(200)).body.entries.map(
        (entry: { path: string }) => entry.path,
      );
      expect(paths).toContain('src');
      expect(paths).toContain('src/lib');
      expect(paths).toContain('src/lib/deep.ts');
    });

    it('brings back a file that is not text', async () => {
      const harness = await running();
      harness.provider.workspace = [
        file('package.json', '{}'),
        { path: 'logo.png', content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]) },
      ];

      await harness.sync().expect(200);

      const stored = await harness.read('logo.png').expect(200);
      expect(stored.body.encoding).toBe('base64');
      expect(stored.body.entry.isBinary).toBe(true);
    });
  });

  describe('what it deletes', () => {
    it('deletes a file the container no longer has', async () => {
      const harness = await running();
      await harness.write('gone.ts', 'temporary');

      harness.provider.workspace = [file('package.json', '{}')];
      const result = workspaceSyncResultSchema.parse((await harness.sync().expect(200)).body);

      expect(result.deleted).toBe(1);
      await harness.read('gone.ts').expect(404);
    });

    it('never deletes a path it was not allowed to read', async () => {
      // The single most destructive mistake available here: treating "not in
      // the archive" as "deleted" for paths that were filtered out of the
      // archive on the way through.
      const harness = await running();
      await harness.write('node_modules/left/index.js', 'kept');
      await harness.write('dist/bundle.js', 'kept');

      harness.provider.workspace = [file('package.json', '{}')];
      await harness.sync().expect(200);

      await harness.read('node_modules/left/index.js').expect(200);
      await harness.read('dist/bundle.js').expect(200);
    });
  });

  describe('when the runtime reports nothing at all', () => {
    it('changes nothing rather than emptying the project', async () => {
      // A container reporting no files is far more likely to be a read that
      // went wrong than a person who deleted everything. Being wrong one way
      // costs a sync that did nothing; the other way it costs the project.
      const harness = await running();
      await harness.write('important.ts', 'work');
      harness.provider.workspace = [];

      const result = workspaceSyncResultSchema.parse((await harness.sync().expect(200)).body);

      expect(result.deleted).toBe(0);
      expect(result.skipped).toContainEqual({ path: '', reason: 'empty-read' });
      await harness.read('important.ts').expect(200);
      await harness.read('package.json').expect(200);
    });

    it('leaves an empty project empty, without complaint', async () => {
      const harness = await running();
      await request(harness.app)
        .delete(`/api/projects/${harness.projectId}/files`)
        .query({ path: 'package.json' })
        .set('Cookie', harness.cookie)
        .expect(204);

      harness.provider.workspace = [];
      const result = workspaceSyncResultSchema.parse((await harness.sync().expect(200)).body);

      expect(result.skipped).toEqual([]);
    });

    it('keeps the project when a runtime is stopped', async () => {
      // Stopping reads the files back, so the same guard has to hold there or
      // stopping a project would be a way to delete it.
      const harness = await running();
      await harness.write('important.ts', 'work');
      harness.provider.workspace = [];

      await harness.stop().expect(200);

      await harness.read('important.ts').expect(200);
    });
  });

  describe('what it refuses', () => {
    it('leaves excluded paths in the container and says so', async () => {
      const harness = await running();
      harness.provider.workspace = [
        file('package.json', '{}'),
        file('node_modules/react/index.js', 'huge'),
      ];

      const result = workspaceSyncResultSchema.parse((await harness.sync().expect(200)).body);

      expect(result.skipped).toContainEqual({
        path: 'node_modules/react/index.js',
        reason: 'excluded',
      });
      await harness.read('node_modules/react/index.js').expect(404);
    });

    it('leaves behind a file too large for the project limits', async () => {
      const harness = await running({ FILE_MAX_BYTES: '2048' });
      harness.provider.workspace = [file('package.json', '{}'), file('big.txt', 'x'.repeat(4096))];

      const result = workspaceSyncResultSchema.parse((await harness.sync().expect(200)).body);

      expect(result.skipped).toContainEqual({ path: 'big.txt', reason: 'too-large' });
    });

    it('refuses a path the project rules would never accept', async () => {
      // A container is code the platform did not write, and a name from it is
      // input.
      const harness = await running();
      harness.provider.workspace = [
        file('package.json', '{}'),
        { path: '../escape.ts', content: new TextEncoder().encode('bad') },
      ];

      const result = workspaceSyncResultSchema.parse((await harness.sync().expect(200)).body);

      expect(result.skipped).toContainEqual({ path: '../escape.ts', reason: 'invalid-path' });
      expect(result.created).toBe(0);
    });

    it('applies nothing at all when the result would breach a limit', async () => {
      // Half a project updated by a build is worse than one not updated.
      const harness = await running({ PROJECT_MAX_BYTES: '4096' });
      harness.provider.workspace = [
        file('package.json', '{}'),
        file('a.txt', 'x'.repeat(3000)),
        file('b.txt', 'x'.repeat(3000)),
      ];

      await harness.sync().expect(413);
      await harness.read('a.txt').expect(404);
      await harness.read('b.txt').expect(404);
    });

    it('refuses when the project is not running', async () => {
      const harness = await running();
      await harness.stop().expect(200);

      const res = await harness.sync().expect(412);
      expect(res.body.error.message).toContain('Start the project');
    });

    it('refuses a viewer, who may not change the project', async () => {
      const harness = await running();
      const viewerCookie = await account(harness.app, 'viewer');
      const viewer = await db!.user.findUniqueOrThrow({ where: { username: 'viewer' } });
      await db!.projectMember.create({
        data: { projectId: harness.projectId, userId: viewer.id, role: 'VIEWER' },
      });

      await request(harness.app)
        .post(`/api/projects/${harness.projectId}/runtime/sync`)
        .set('Cookie', viewerCookie)
        .send({})
        .expect(403);
    });
  });

  describe('stopping', () => {
    it('reads the files back before the container goes', async () => {
      // The last moment anything inside can be recovered. Someone who ran an
      // install and then pressed Stop should not lose it.
      const harness = await running();
      harness.provider.workspace = [file('package.json', '{}'), file('made-by-a-command.ts', 'x')];

      await harness.stop().expect(200);

      await harness.read('made-by-a-command.ts').expect(200);
    });

    it('still stops when the files cannot be read', async () => {
      // Refusing to stop would leave a container running that someone asked to
      // be rid of, with no way to make it go.
      const harness = await running();
      harness.provider.failOn = 'read';

      const res = await harness.stop().expect(200);
      expect(res.body.runtime.status).toBe('STOPPED');
    });
  });
});
