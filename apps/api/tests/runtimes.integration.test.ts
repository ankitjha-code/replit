import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runtimeHistoryResponseSchema, runtimeStateResponseSchema } from '@platform/shared';
import { loadEnv } from '../src/config/env.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import { RecordingExecutionProvider } from './setup/execution.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * The runtime lifecycle over real HTTP against the real database.
 *
 * Two things are being checked. First, that an installation with no execution
 * backend refuses honestly and writes nothing. Second, that when a provider is
 * present the state machine is walked in order, a failure is recorded rather
 * than swallowed, and two racing requests cannot both win.
 *
 * The provider is a recording double. What is under test here is the control
 * plane's rules, not Docker.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

function buildApp(options: { provider?: RecordingExecutionProvider } = {}) {
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_PROJECT_CREATE_MAX: '100',
    RATE_LIMIT_RUNTIME_CONTROL_MAX: '100',
  } as NodeJS.ProcessEnv);

  const auth = testAuth(
    db!,
    config,
    new FakePasswordHasher(),
    silentLogger(),
    // Omitted on purpose in most tests: the default is the same refusal a real
    // installation with nothing configured gives.
    options.provider,
  );

  return { auth, config, app: testApp({ config, auth }) };
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

async function project(app: App, cookie: string, name = 'Runtime'): Promise<string> {
  const res = await request(app)
    .post('/api/projects')
    .set('Cookie', cookie)
    .send({ name })
    .expect(201);
  return res.body.project.id as string;
}

const runtime = (app: App, projectId: string, cookie: string) => ({
  get: () => request(app).get(`/api/projects/${projectId}/runtime`).set('Cookie', cookie),
  events: () => request(app).get(`/api/projects/${projectId}/runtime/events`).set('Cookie', cookie),
  start: (body?: Record<string, unknown>) =>
    request(app)
      .post(`/api/projects/${projectId}/runtime/start`)
      .set('Cookie', cookie)
      .send(body ?? {}),
  stop: () =>
    request(app).post(`/api/projects/${projectId}/runtime/stop`).set('Cookie', cookie).send({}),
});

async function writeFile(app: App, projectId: string, cookie: string, path: string) {
  await request(app)
    .put(`/api/projects/${projectId}/files/content`)
    .set('Cookie', cookie)
    .send({ path, content: '{}', encoding: 'utf8' })
    .expect(200);
}

/** A signed-in owner with a project that declares a Node runtime. */
async function nodeProject(options: { provider?: RecordingExecutionProvider } = {}) {
  const built = buildApp(options);
  const cookie = await account(built.app, 'ada');
  const projectId = await project(built.app, cookie);
  await writeFile(built.app, projectId, cookie, 'package.json');
  return { ...built, cookie, projectId, api: runtime(built.app, projectId, cookie) };
}

describe.skipIf(!db)('runtimes over HTTP', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  describe('with no execution backend configured', () => {
    it('says so plainly rather than showing a project as startable', async () => {
      const { api } = await nodeProject();

      const res = await api.get().expect(200);
      const body = runtimeStateResponseSchema.parse(res.body);

      expect(body.runtime).toBeNull();
      expect(body.provider.available).toBe(false);
      expect(body.provider.reason).toContain('no execution backend');
    });

    it('still reports which runtime the project needs', async () => {
      // Detection does not depend on being able to run anything, and telling
      // someone what their project is remains useful.
      const { api } = await nodeProject();

      const body = runtimeStateResponseSchema.parse((await api.get().expect(200)).body);
      expect(body.detected?.language).toBe('node');
      expect(body.detected?.evidence).toBe('package.json');
    });

    it('refuses to start, and the reason reaches the caller', async () => {
      const { api } = await nodeProject();

      const res = await api.start().expect(503);

      expect(res.body.error.code).toBe('RUNTIME_UNAVAILABLE');
      // The whole point of a 503 message. Replacing it with "an unexpected
      // error occurred" would send someone hunting for a bug in their project.
      expect(res.body.error.message).toContain('no execution backend');
    });

    it('records no runtime for a start it refused', async () => {
      // A row here would describe a container that will never exist, and the
      // workspace would show a project that had been started.
      const { api } = await nodeProject();
      await api.start().expect(503);

      expect(await db!.runtime.count()).toBe(0);
      const body = runtimeStateResponseSchema.parse((await api.get().expect(200)).body);
      expect(body.runtime).toBeNull();
    });

    it('treats stopping nothing as done rather than as an error', async () => {
      const { api } = await nodeProject();
      const res = await api.stop().expect(200);
      expect(runtimeStateResponseSchema.parse(res.body).runtime).toBeNull();
    });
  });

  describe('starting', () => {
    it('walks the states in order and ends running', async () => {
      const provider = new RecordingExecutionProvider();
      const { api } = await nodeProject({ provider });

      const res = await api.start().expect(200);
      const body = runtimeStateResponseSchema.parse(res.body);

      expect(body.runtime?.status).toBe('RUNNING');
      expect(body.provider.available).toBe(true);

      const events = runtimeHistoryResponseSchema.parse((await api.events().expect(200)).body);
      expect(events.events.map((event) => event.to)).toEqual([
        'RUNNING',
        'STARTING',
        'CREATING',
        'REQUESTED',
      ]);
    });

    it('asks the provider for the image the project needs', async () => {
      const provider = new RecordingExecutionProvider();
      const { api } = await nodeProject({ provider });
      await api.start().expect(200);

      expect(provider.created).toHaveLength(1);
      expect(provider.created[0]?.image).toContain('node');
    });

    it('applies a resource ceiling to every workload', async () => {
      // A development environment with no limit lets one project take the host
      // away from every other project on it.
      const provider = new RecordingExecutionProvider();
      const { api } = await nodeProject({ provider });
      await api.start().expect(200);

      const limits = provider.created[0]?.limits;
      expect(limits?.cpuMillicores).toBeGreaterThan(0);
      expect(limits?.memoryMb).toBeGreaterThan(0);
      // Neither a CPU share nor a memory cap stops a fork bomb.
      expect(limits?.pidsLimit).toBeGreaterThan(0);
    });

    it('hands the workload no platform configuration', async () => {
      // The workload runs code the platform did not write. Database
      // credentials and session secrets must never be within its reach.
      const provider = new RecordingExecutionProvider();
      const { api } = await nodeProject({ provider });
      await api.start().expect(200);

      expect(provider.created[0]?.env).toEqual({});
    });

    it('copies the project files into the workload', async () => {
      // The database is the source of truth for a project's source. A
      // container that started empty would make the workspace a lie.
      const provider = new RecordingExecutionProvider();
      const { api } = await nodeProject({ provider });
      await api.start().expect(200);

      expect(provider.seeded).toHaveLength(1);
      expect(provider.seeded[0]?.entries.map((entry) => entry.path)).toContain('package.json');
    });

    it('copies the files before starting, never after', async () => {
      // A workload that starts first can observe a half-populated workspace,
      // and a build tool watching the directory would act on it.
      const provider = new RecordingExecutionProvider();
      provider.failOn = 'seed';
      const { api } = await nodeProject({ provider });

      await api.start().expect(500);
      expect(provider.started).toHaveLength(0);
    });

    it('does not publish the provider own identifier', async () => {
      // A container id is useful to an operator and useless to a browser, and
      // publishing it describes the shape of the execution plane.
      const provider = new RecordingExecutionProvider();
      const { api } = await nodeProject({ provider });
      const res = await api.start().expect(200);

      expect(JSON.stringify(res.body)).not.toContain('workload-');
    });

    it('starts nothing twice', async () => {
      const provider = new RecordingExecutionProvider();
      const { api } = await nodeProject({ provider });

      await api.start().expect(200);
      const second = await api.start().expect(200);

      expect(runtimeStateResponseSchema.parse(second.body).runtime?.status).toBe('RUNNING');
      expect(provider.created).toHaveLength(1);
    });

    it('refuses a project that does not say what it is', async () => {
      const provider = new RecordingExecutionProvider();
      const built = buildApp({ provider });
      const cookie = await account(built.app, 'ada');
      const projectId = await project(built.app, cookie);
      await writeFile(built.app, projectId, cookie, 'notes.txt');

      const res = await runtime(built.app, projectId, cookie).start().expect(412);

      expect(res.body.error.code).toBe('PRECONDITION_FAILED');
      expect(res.body.error.message).toContain('package.json');
      expect(provider.created).toHaveLength(0);
    });

    it('accepts an explicit language when detection would not decide', async () => {
      const provider = new RecordingExecutionProvider();
      const built = buildApp({ provider });
      const cookie = await account(built.app, 'ada');
      const projectId = await project(built.app, cookie);
      await writeFile(built.app, projectId, cookie, 'notes.txt');

      const res = await runtime(built.app, projectId, cookie)
        .start({ language: 'python' })
        .expect(200);

      expect(runtimeStateResponseSchema.parse(res.body).runtime?.language).toBe('python');
    });

    it('refuses a language the platform does not have', async () => {
      const { api } = await nodeProject({ provider: new RecordingExecutionProvider() });
      const res = await api.start({ language: 'cobol' }).expect(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('needs no request body at all', async () => {
      const provider = new RecordingExecutionProvider();
      const { app, projectId, cookie } = await nodeProject({ provider });

      await request(app)
        .post(`/api/projects/${projectId}/runtime/start`)
        .set('Cookie', cookie)
        .expect(200);
    });
  });

  describe('when starting fails', () => {
    it('records the failure instead of leaving the runtime mid-flight', async () => {
      const provider = new RecordingExecutionProvider();
      provider.failOn = 'create';
      const { api } = await nodeProject({ provider });

      const res = await api.start().expect(500);
      expect(res.body.error.code).toBe('EXECUTION_FAILED');

      const body = runtimeStateResponseSchema.parse((await api.get().expect(200)).body);
      expect(body.runtime?.status).toBe('FAILED');
      expect(body.runtime?.message).toBeTruthy();
    });

    it('keeps the provider own error out of the response', async () => {
      const provider = new RecordingExecutionProvider();
      provider.failOn = 'start';
      provider.failure = new Error('dial unix /var/run/docker.sock: permission denied');
      const { api } = await nodeProject({ provider });

      const res = await api.start().expect(500);

      // A host path in a browser is an information leak, and useless to the
      // person reading it.
      expect(JSON.stringify(res.body)).not.toContain('docker.sock');
    });

    it('can be started again after a failure', async () => {
      // A failed runtime must be recoverable without an administrator.
      const provider = new RecordingExecutionProvider();
      provider.failOn = 'create';
      const { api } = await nodeProject({ provider });
      await api.start().expect(500);

      provider.failOn = undefined;
      const res = await api.start().expect(200);

      expect(runtimeStateResponseSchema.parse(res.body).runtime?.status).toBe('RUNNING');
    });

    it('removes the workload it could not start', async () => {
      // A container created and never run holds its name and its share of the
      // host for ever, and the next start would find the name taken.
      const provider = new RecordingExecutionProvider();
      provider.failOn = 'start';
      const { api } = await nodeProject({ provider });

      await api.start().expect(500);

      expect(provider.destroyed).toHaveLength(1);
      expect(provider.destroyed[0]).toBe('workload-1');
    });

    it('records the workload identifier before anything else can fail', async () => {
      // Without this the cleanup above has nothing to act on: a workload the
      // database cannot name is a workload nobody will ever remove.
      const provider = new RecordingExecutionProvider();
      provider.failOn = 'seed';
      const { api } = await nodeProject({ provider });

      await api.start().expect(500);
      expect(provider.destroyed).toHaveLength(1);
    });

    it('reports a copy failure as its own problem', async () => {
      const provider = new RecordingExecutionProvider();
      provider.failOn = 'seed';
      const { api } = await nodeProject({ provider });

      const res = await api.start().expect(500);
      expect(res.body.error.message).toContain('files could not be copied');
    });

    it('leaves a history that says what happened', async () => {
      const provider = new RecordingExecutionProvider();
      provider.failOn = 'create';
      const { api } = await nodeProject({ provider });
      await api.start().expect(500);

      const events = runtimeHistoryResponseSchema.parse((await api.events().expect(200)).body);
      expect(events.events[0]?.to).toBe('FAILED');
      expect(events.events[0]?.from).toBe('CREATING');
      expect(events.events[0]?.reason).toBeTruthy();
    });
  });

  describe('stopping', () => {
    it('stops a running runtime and says when', async () => {
      const provider = new RecordingExecutionProvider();
      const { api } = await nodeProject({ provider });
      await api.start().expect(200);

      const res = await api.stop().expect(200);
      const body = runtimeStateResponseSchema.parse(res.body);

      expect(body.runtime?.status).toBe('STOPPED');
      expect(body.runtime?.stoppedAt).not.toBeNull();
      expect(provider.stopped).toHaveLength(1);
    });

    it('gives the workload a grace period before it is killed', async () => {
      const provider = new RecordingExecutionProvider();
      const { api } = await nodeProject({ provider });
      await api.start().expect(200);
      await api.stop().expect(200);

      expect(provider.stopped[0]?.graceSeconds).toBeGreaterThan(0);
    });

    it('treats a second stop as already done', async () => {
      const provider = new RecordingExecutionProvider();
      const { api } = await nodeProject({ provider });
      await api.start().expect(200);
      await api.stop().expect(200);

      const res = await api.stop().expect(200);
      expect(runtimeStateResponseSchema.parse(res.body).runtime?.status).toBe('STOPPED');
      expect(provider.stopped).toHaveLength(1);
    });

    it('records a failure to stop rather than reporting it stopped', async () => {
      const provider = new RecordingExecutionProvider();
      const { api } = await nodeProject({ provider });
      await api.start().expect(200);

      provider.failOn = 'stop';
      await api.stop().expect(500);

      const body = runtimeStateResponseSchema.parse((await api.get().expect(200)).body);
      expect(body.runtime?.status).toBe('FAILED');
    });
  });

  describe('restarting', () => {
    it('re-reads what the project is rather than reusing the old image', async () => {
      // A project that was Node last week and Python today must not come back
      // on the image it used last time.
      const provider = new RecordingExecutionProvider();
      const { api, app, projectId, cookie } = await nodeProject({ provider });
      await api.start().expect(200);
      await api.stop().expect(200);

      await request(app)
        .delete(`/api/projects/${projectId}/files`)
        .query({ path: 'package.json' })
        .set('Cookie', cookie)
        .expect(204);
      await writeFile(app, projectId, cookie, 'requirements.txt');

      const res = await api.start().expect(200);
      expect(runtimeStateResponseSchema.parse(res.body).runtime?.language).toBe('python');
      expect(provider.created[1]?.image).toContain('python');
    });

    it('keeps one runtime row for a project no matter how often it restarts', async () => {
      const provider = new RecordingExecutionProvider();
      const { api } = await nodeProject({ provider });

      await api.start().expect(200);
      await api.stop().expect(200);
      await api.start().expect(200);

      expect(await db!.runtime.count()).toBe(1);
    });
  });

  describe('races', () => {
    it('lets only one of several simultaneous starts create a workload', async () => {
      // Every request finds no runtime, because none has written yet. Only the
      // unique constraint on the project decides which one proceeds, which is
      // why the check is in the database and not in the service.
      const provider = new RecordingExecutionProvider();
      const { api } = await nodeProject({ provider });

      const results = await Promise.all([api.start(), api.start(), api.start(), api.start()]);

      // Every caller gets an answer, and none of them gets a server error.
      expect(results.map((result) => result.status)).toEqual([200, 200, 200, 200]);
      // One container, not four.
      expect(provider.created).toHaveLength(1);
      expect(await db!.runtime.count()).toBe(1);
    });

    it('lets only one of two simultaneous stops act', async () => {
      const provider = new RecordingExecutionProvider();
      const { api } = await nodeProject({ provider });
      await api.start().expect(200);

      const results = await Promise.all([api.stop(), api.stop()]);

      // The loser is told the state changed under it rather than being
      // silently told the stop it did not perform succeeded.
      expect(results.filter((result) => result.status === 200)).toHaveLength(1);
      expect(results.filter((result) => result.status === 409)).toHaveLength(1);
      expect(provider.stopped).toHaveLength(1);
    });
  });

  describe('access', () => {
    it('refuses an anonymous caller', async () => {
      const { app, projectId } = await nodeProject();
      await request(app).get(`/api/projects/${projectId}/runtime`).expect(401);
    });

    it('hides another account project behind a not found', async () => {
      const { app, projectId } = await nodeProject();
      const intruder = await account(app, 'mallory');

      await request(app)
        .get(`/api/projects/${projectId}/runtime`)
        .set('Cookie', intruder)
        .expect(404);
    });

    it('lets a viewer see the state', async () => {
      const provider = new RecordingExecutionProvider();
      const { app, projectId, cookie } = await nodeProject({ provider });
      const viewerCookie = await account(app, 'viewer');
      const viewer = await db!.user.findUniqueOrThrow({ where: { username: 'viewer' } });
      await db!.projectMember.create({
        data: { projectId, userId: viewer.id, role: 'VIEWER' },
      });

      await runtime(app, projectId, cookie).start().expect(200);
      const res = await runtime(app, projectId, viewerCookie).get().expect(200);

      expect(runtimeStateResponseSchema.parse(res.body).runtime?.status).toBe('RUNNING');
    });

    it('does not let a viewer spend the host resources', async () => {
      const provider = new RecordingExecutionProvider();
      const { app, projectId } = await nodeProject({ provider });
      const viewerCookie = await account(app, 'viewer');
      const viewer = await db!.user.findUniqueOrThrow({ where: { username: 'viewer' } });
      await db!.projectMember.create({
        data: { projectId, userId: viewer.id, role: 'VIEWER' },
      });

      await runtime(app, projectId, viewerCookie).start().expect(403);
      await runtime(app, projectId, viewerCookie).stop().expect(403);
      expect(provider.created).toHaveLength(0);
    });
  });

  describe('limits', () => {
    it('bounds how often one account may start and stop', async () => {
      const provider = new RecordingExecutionProvider();
      const config = loadEnv({
        RATE_LIMIT_REGISTER_MAX: '100',
        RATE_LIMIT_PROJECT_CREATE_MAX: '100',
        RATE_LIMIT_RUNTIME_CONTROL_MAX: '2',
      } as NodeJS.ProcessEnv);
      const auth = testAuth(db!, config, new FakePasswordHasher(), silentLogger(), provider);
      const app = testApp({ config, auth });

      const cookie = await account(app, 'ada');
      const projectId = await project(app, cookie);
      await writeFile(app, projectId, cookie, 'package.json');
      const api = runtime(app, projectId, cookie);

      await api.start().expect(200);
      await api.stop().expect(200);
      const third = await api.start();

      expect(third.status).toBe(429);
    });
  });
});

describe.skipIf(!db)('the disk limit', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  const MB = 1024 * 1024;

  it('stops an environment that wrote past its limit, and says why', async () => {
    const provider = new RecordingExecutionProvider();
    const w = await nodeProject({ provider });
    await w.api.start().expect(200);
    const running = await db!.runtime.findFirstOrThrow({ where: { projectId: w.projectId } });
    provider.disk.set(running.externalId!, 300 * MB);

    const report = await w.auth.runtimes.enforceDiskLimit(200 * MB);

    expect(report).toEqual({ checked: 1, stopped: 1 });
    const state = await w.api.get().expect(200);
    expect(state.body.runtime.status).toBe('STOPPED');
    expect(JSON.stringify(state.body)).toMatch(/wrote 300 MB to disk, over its 200 MB limit/);
  });

  it('leaves an environment under its limit, or one that cannot be measured, alone', async () => {
    const provider = new RecordingExecutionProvider();
    const w = await nodeProject({ provider });
    await w.api.start().expect(200);
    const running = await db!.runtime.findFirstOrThrow({ where: { projectId: w.projectId } });

    expect(await w.auth.runtimes.enforceDiskLimit(200 * MB)).toEqual({ checked: 1, stopped: 0 });
    provider.disk.set(running.externalId!, 150 * MB);
    expect(await w.auth.runtimes.enforceDiskLimit(200 * MB)).toEqual({ checked: 1, stopped: 0 });
    expect((await w.api.get().expect(200)).body.runtime.status).toBe('RUNNING');
  });
});
