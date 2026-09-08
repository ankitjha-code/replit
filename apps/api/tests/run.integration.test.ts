import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runStateSchema } from '@platform/shared';
import { loadEnv } from '../src/config/env.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import { RecordingExecutionProvider } from './setup/execution.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * Running a project's own application, over real HTTP.
 *
 * The provider is a recording double, so what the program does is decided by
 * the test. What is under test is the rule set around it: what may be run,
 * when, what happens when it ends, and what the platform says it knows.
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
  return { provider, auth, app: testApp({ config, auth }) };
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

/** A signed-in owner with a started runtime. */
async function workspace(options: { files?: Record<string, string>; started?: boolean } = {}) {
  const built = buildApp();
  const cookie = await account(built.app, 'ada');

  const created = await request(built.app)
    .post('/api/projects')
    .set('Cookie', cookie)
    .send({ name: 'Run' })
    .expect(201);
  const projectId = created.body.project.id as string;

  const files = options.files ?? { 'package.json': '{"scripts":{"start":"node server.js"}}' };
  for (const [path, content] of Object.entries(files)) {
    await request(built.app)
      .put(`/api/projects/${projectId}/files/content`)
      .set('Cookie', cookie)
      .send({ path, content, encoding: 'utf8' })
      .expect(200);
  }

  if (options.started !== false) {
    await request(built.app)
      .post(`/api/projects/${projectId}/runtime/start`)
      .set('Cookie', cookie)
      .send({})
      .expect(200);
  }

  const base = `/api/projects/${projectId}/runtime/run`;

  return {
    ...built,
    cookie,
    projectId,
    state: () => request(built.app).get(base).set('Cookie', cookie),
    start: () => request(built.app).post(`${base}/start`).set('Cookie', cookie).send({}),
    stop: () => request(built.app).post(`${base}/stop`).set('Cookie', cookie).send({}),
    setCommand: (command: string | null) =>
      request(built.app).put(`${base}/command`).set('Cookie', cookie).send({ command }),
    stopRuntime: () =>
      request(built.app)
        .post(`/api/projects/${projectId}/runtime/stop`)
        .set('Cookie', cookie)
        .send({}),
    preview: () =>
      request(built.app).get(`/api/projects/${projectId}/preview`).set('Cookie', cookie),
    /** A fresh set of services over the same database, as a restart gives. */
    restart: () => {
      const config = loadEnv({
        RATE_LIMIT_REGISTER_MAX: '100',
        RATE_LIMIT_PROJECT_CREATE_MAX: '100',
        RATE_LIMIT_RUNTIME_CONTROL_MAX: '100',
      } as NodeJS.ProcessEnv);
      const auth = testAuth(db!, config, new FakePasswordHasher(), silentLogger(), built.provider);
      return testApp({ config, auth });
    },
  };
}

describe.skipIf(!db)('running an application', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  describe('what the platform would run', () => {
    it('suggests the start script the project declares', async () => {
      const harness = await workspace();
      const state = runStateSchema.parse((await harness.state().expect(200)).body);

      expect(state.suggestion?.command).toBe('npm start');
      expect(state.suggestion?.reason).toContain('package.json');
      expect(state.status).toBe('IDLE');
    });

    it('suggests an entry point when the manifest declares none', async () => {
      const harness = await workspace({ files: { 'package.json': '{}', 'index.js': 'x' } });
      const state = runStateSchema.parse((await harness.state().expect(200)).body);

      expect(state.suggestion?.command).toBe('node index.js');
    });

    it('says it cannot tell, rather than guessing', async () => {
      const harness = await workspace({ files: { 'package.json': '{}', 'README.md': 'hi' } });
      const state = runStateSchema.parse((await harness.state().expect(200)).body);

      expect(state.suggestion).toBeNull();
      expect(state.blockedReason).toContain('does not say how to start');
    });

    it('says to start the project first when nothing is running', async () => {
      const harness = await workspace({ started: false });
      const state = runStateSchema.parse((await harness.state().expect(200)).body);

      expect(state.blockedReason).toContain('Start the project');
    });

    it('still says what it would run before anything has been started', async () => {
      // The files are the same evidence the platform uses to choose an image,
      // so there is no reason to withhold the answer until a container exists.
      // Someone deciding whether to start one wants to know what would happen.
      const harness = await workspace({ started: false });
      const state = runStateSchema.parse((await harness.state().expect(200)).body);

      expect(state.suggestion?.command).toBe('npm start');
    });
  });

  describe('a command the project sets', () => {
    it('is used instead of the suggestion', async () => {
      const harness = await workspace();
      await harness.setCommand('node custom.js').expect(200);

      await harness.start().expect(200);

      expect(harness.provider.startedCommands).toEqual(['node custom.js']);
    });

    it('survives the runtime being stopped and started again', async () => {
      // Telling the platform once should be enough.
      const harness = await workspace();
      await harness.setCommand('node custom.js').expect(200);
      await harness.stopRuntime().expect(200);

      await request(harness.app)
        .post(`/api/projects/${harness.projectId}/runtime/start`)
        .set('Cookie', harness.cookie)
        .send({})
        .expect(200);

      const state = runStateSchema.parse((await harness.state().expect(200)).body);
      expect(state.configuredCommand).toBe('node custom.js');
    });

    it('can be cleared back to the suggestion', async () => {
      const harness = await workspace();
      await harness.setCommand('node custom.js').expect(200);

      const state = runStateSchema.parse((await harness.setCommand(null).expect(200)).body);

      expect(state.configuredCommand).toBeNull();
      expect(state.suggestion?.command).toBe('npm start');
    });

    it('refuses a command carrying characters nobody types', async () => {
      const harness = await workspace();
      const res = await harness.setCommand(`node ${String.fromCharCode(0x1b)}[2K.js`).expect(422);

      expect(JSON.stringify(res.body)).toContain('control characters');
    });

    it('is something an editor may set', async () => {
      // An editor can already rewrite the start script in package.json, so
      // refusing them the run command would protect nothing and only make the
      // two ways of saying the same thing disagree.
      const harness = await workspace();
      const editorCookie = await account(harness.app, 'editor');
      const editor = await db!.user.findUniqueOrThrow({ where: { username: 'editor' } });
      await db!.projectMember.create({
        data: { projectId: harness.projectId, userId: editor.id, role: 'EDITOR' },
      });

      await request(harness.app)
        .put(`/api/projects/${harness.projectId}/runtime/run/command`)
        .set('Cookie', editorCookie)
        .send({ command: 'node custom.js' })
        .expect(200);
    });

    it('is not something a viewer may set', async () => {
      const harness = await workspace();
      const viewerCookie = await account(harness.app, 'viewer');
      const viewer = await db!.user.findUniqueOrThrow({ where: { username: 'viewer' } });
      await db!.projectMember.create({
        data: { projectId: harness.projectId, userId: viewer.id, role: 'VIEWER' },
      });

      await request(harness.app)
        .put(`/api/projects/${harness.projectId}/runtime/run/command`)
        .set('Cookie', viewerCookie)
        .send({ command: 'node evil.js' })
        .expect(403);
    });
  });

  describe('starting', () => {
    it('runs the command and reports it running', async () => {
      const harness = await workspace();
      const state = runStateSchema.parse((await harness.start().expect(200)).body);

      expect(state.status).toBe('RUNNING');
      expect(state.command).toBe('npm start');
      expect(state.startedAt).not.toBeNull();
    });

    it('refuses when the runtime is not up', async () => {
      const harness = await workspace({ started: false });
      const res = await harness.start().expect(412);

      expect(res.body.error.message).toContain('Start the project');
      expect(harness.provider.startedCommands).toEqual([]);
    });

    it('refuses when the project does not say how to start', async () => {
      const harness = await workspace({ files: { 'package.json': '{}' } });
      await harness.start().expect(412);
    });

    it('refuses a second one rather than running two', async () => {
      // Two would make "is it running" unanswerable, and leave the first with
      // nothing able to stop it.
      const harness = await workspace();
      await harness.start().expect(200);

      const res = await harness.start().expect(409);
      expect(res.body.error.message).toContain('already running');
      expect(harness.provider.startedCommands).toHaveLength(1);
    });

    it('records a failure to start rather than reporting it running', async () => {
      const harness = await workspace();
      harness.provider.failOn = 'run';

      await harness.start().expect(500);

      const state = runStateSchema.parse((await harness.state().expect(200)).body);
      expect(state.status).toBe('FAILED');
    });

    it('refuses a viewer, who may watch but not spend the host', async () => {
      const harness = await workspace();
      const viewerCookie = await account(harness.app, 'viewer');
      const viewer = await db!.user.findUniqueOrThrow({ where: { username: 'viewer' } });
      await db!.projectMember.create({
        data: { projectId: harness.projectId, userId: viewer.id, role: 'VIEWER' },
      });

      await request(harness.app)
        .get(`/api/projects/${harness.projectId}/runtime/run`)
        .set('Cookie', viewerCookie)
        .expect(200);

      await request(harness.app)
        .post(`/api/projects/${harness.projectId}/runtime/run/start`)
        .set('Cookie', viewerCookie)
        .send({})
        .expect(403);
    });
  });

  describe('when the application ends', () => {
    it('reports a clean exit as finished', async () => {
      const harness = await workspace();
      await harness.start().expect(200);

      harness.provider.process?.end(0);
      await settle();

      const state = runStateSchema.parse((await harness.state().expect(200)).body);
      expect(state.status).toBe('EXITED');
      expect(state.exitCode).toBe(0);
    });

    it('reports a crash as a failure, with its code', async () => {
      const harness = await workspace();
      await harness.start().expect(200);

      harness.provider.process?.end(1);
      await settle();

      const state = runStateSchema.parse((await harness.state().expect(200)).body);
      expect(state.status).toBe('FAILED');
      expect(state.exitCode).toBe(1);
      expect(state.message).toContain('1');
    });

    it('does not call a program lost because it ended quickly', async () => {
      /*
       * The window between a program ending and its exit being written down.
       *
       * A read landing in there finds a record that says RUNNING and a
       * provider that says nothing is running, and the honest conclusion from
       * those two facts alone is that the platform restarted. It did not, and
       * the exit code it would overwrite is the one thing worth knowing about
       * a program that failed immediately.
       */
      const harness = await workspace();
      await harness.start().expect(200);

      harness.provider.process?.end(3);
      // No settle: the read is meant to land mid-flight.
      await harness.state().expect(200);

      // Polled rather than slept for: the exit is written asynchronously, and a
      // fixed wait that is long enough alone is not long enough under a full run.
      const state = await eventually(
        async () => runStateSchema.parse((await harness.state().expect(200)).body),
        (value) => value.status === 'FAILED',
      );
      expect(state.status).toBe('FAILED');
      expect(state.exitCode).toBe(3);
      expect(state.message).not.toContain('restarted');
    });

    it('can be started again afterwards', async () => {
      const harness = await workspace();
      await harness.start().expect(200);
      harness.provider.process?.end(1);
      await settle();

      const state = runStateSchema.parse((await harness.start().expect(200)).body);
      expect(state.status).toBe('RUNNING');
    });
  });

  describe('stopping', () => {
    it('stops a running application', async () => {
      const harness = await workspace();
      await harness.start().expect(200);

      const state = runStateSchema.parse((await harness.stop().expect(200)).body);
      expect(state.status).toBe('EXITED');
    });

    it('treats stopping nothing as already done', async () => {
      const harness = await workspace();
      const state = runStateSchema.parse((await harness.stop().expect(200)).body);
      expect(state.status).toBe('IDLE');
    });

    it('stops the application when the runtime stops', async () => {
      const harness = await workspace();
      await harness.start().expect(200);

      await harness.stopRuntime().expect(200);

      const state = runStateSchema.parse((await harness.state().expect(200)).body);
      expect(state.status).not.toBe('RUNNING');
    });
  });

  describe('what the platform claims to know', () => {
    it('corrects itself after a restart, when the application went away unwatched', async () => {
      /*
       * A control plane that restarted holds nothing: no stream, no listeners,
       * no memory of what was running. Simulated by building a second set of
       * services over the same database and the same container, which is
       * exactly what a restart produces.
       */
      const harness = await workspace();
      await harness.start().expect(200);

      const restarted = harness.restart();
      // The program ended while nobody was watching.
      harness.provider.process = undefined;

      const state = runStateSchema.parse(
        (
          await request(restarted)
            .get(`/api/projects/${harness.projectId}/runtime/run`)
            .set('Cookie', harness.cookie)
            .expect(200)
        ).body,
      );

      expect(state.status).toBe('EXITED');
      expect(state.message).toContain('no longer running');
    });

    it('keeps reporting an application it is still watching', async () => {
      const harness = await workspace();
      await harness.start().expect(200);

      const state = runStateSchema.parse((await harness.state().expect(200)).body);
      expect(state.status).toBe('RUNNING');
    });
  });

  describe('what the preview says about it', () => {
    it('says the application has not been started', async () => {
      const harness = await workspace();
      const preview = (await harness.preview().expect(200)).body;

      expect(preview.reason).toContain('has not been started');
    });

    it('says the application crashed, and points at the output', async () => {
      const harness = await workspace();
      await harness.start().expect(200);
      harness.provider.process?.end(1);

      const preview = await eventually(
        async () => (await harness.preview().expect(200)).body as { reason: string },
        (value) => value.reason.includes('exited with code 1'),
      );
      expect(preview.reason).toContain('exited with code 1');
      expect(preview.reason).toContain('output');
    });

    it('says it is running but not serving yet', async () => {
      const harness = await workspace();
      await harness.start().expect(200);

      const preview = (await harness.preview().expect(200)).body;
      expect(preview.reason).toContain('nothing is listening');
    });
  });
});

/** Lets the exit handler's own writes finish before the state is read. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * Reads until a condition holds, or gives up and returns the last reading.
 *
 * Returning rather than throwing on timeout, so the assertion that follows
 * fails with the real value in its message instead of "timed out".
 */
async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}
