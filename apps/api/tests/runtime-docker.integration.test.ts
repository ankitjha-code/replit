import request from 'supertest';
import { pino } from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runtimeStateResponseSchema } from '@platform/shared';
import { loadEnv } from '../src/config/env.js';
import {
  createDockerClient,
  DockerExecutionProvider,
} from '../src/execution/docker/docker-provider.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * Pressing Run, end to end.
 *
 * The whole path with nothing stood in for: real HTTP, the real database, the
 * real Docker daemon, a real container. The Docker suite proves the provider
 * behaves; this proves the control plane and the provider are actually joined
 * up, and that a project's files reach the container they were supposed to.
 *
 * Uses the static runtime because its image is the smallest in the catalogue.
 * Skips when either the database or Docker is absent.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

const docker = createDockerClient(process.env.DOCKER_SOCKET_PATH);
const dockerUp = await docker
  .ping()
  .then(() => true)
  .catch(() => false);

const NETWORK = 'platform-runtimes-e2e';

function buildApp() {
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_PROJECT_CREATE_MAX: '100',
    RATE_LIMIT_RUNTIME_CONTROL_MAX: '100',
  } as NodeJS.ProcessEnv);

  const provider = new DockerExecutionProvider(
    docker,
    {
      workspacePath: config.RUNTIME_WORKSPACE_PATH,
      networkPrefix: NETWORK,
      terminalReplayBytes: 64 * 1024,
      hardening: {
        // Set TEST_OCI_RUNTIME=runsc to run this suite under gVisor.
        ociRuntime: process.env.TEST_OCI_RUNTIME ?? null,
        maxOpenFiles: 8_192,
        maxProcesses: 128,
        workloadUser: '1000:1000',
        homePath: '/home/workload',
        tmpMegabytes: 256,
      },
      pullTimeoutMs: 600_000,
      availabilityTtlMs: 0,
      read: {
        maxFileBytes: 1_000_000,
        maxTotalBytes: 10_000_000,
        maxFiles: 1_000,
        applyExclusions: true,
      },
      collect: {
        maxFileBytes: 1_000_000,
        maxTotalBytes: 10_000_000,
        maxFiles: 1_000,
        applyExclusions: false,
      },
    },
    pino({ level: 'silent' }),
  );

  const auth = testAuth(db!, config, new FakePasswordHasher(), silentLogger(), provider);
  return { app: testApp({ config, auth }), provider };
}

type App = ReturnType<typeof buildApp>['app'];

async function account(app: App): Promise<string> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'ada@example.test', username: 'ada', password: 'analytical-engine-1843' })
    .expect(201);

  const header = res.headers['set-cookie'] as unknown as string[];
  return header.find((c) => c.startsWith('platform_session='))!.split(';')[0]!;
}

/** Reads a file out of a container, to see what actually landed in it. */
async function readInContainer(containerId: string, path: string): Promise<string> {
  const instance = await docker.getContainer(containerId).exec({
    Cmd: ['/bin/sh', '-c', `cat ${path}`],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await instance.start({ hijack: true, stdin: false });

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

describe.skipIf(!db || !dockerUp)('starting a project for real', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  afterEach(async () => {
    // Every container this suite made, found through the database rather than
    // by guessing at names.
    const runtimes = await db!.runtime.findMany();
    for (const runtime of runtimes) {
      if (!runtime.externalId) continue;
      await docker
        .getContainer(runtime.externalId)
        .remove({ force: true, v: true })
        .catch(() => undefined);
    }
  });

  afterAll(async () => {
    // One network per project since task 53; the old single name matched
    // nothing, so every run leaked one.
    const { pino: logger } = await import('pino');
    const { createDockerClient: client, DockerExecutionProvider: Provider } =
      await import('../src/execution/docker/docker-provider.js');
    const sweeper = new Provider(
      client(process.env.DOCKER_SOCKET_PATH),
      {
        workspacePath: '/workspace',
        networkPrefix: NETWORK,
        terminalReplayBytes: 1024,
        hardening: {
          // Set TEST_OCI_RUNTIME=runsc to run this suite under gVisor.
          ociRuntime: process.env.TEST_OCI_RUNTIME ?? null,
          maxOpenFiles: 1024,
          maxProcesses: 64,
          workloadUser: '1000:1000',
          homePath: '/home/workload',
          tmpMegabytes: 16,
        },
        pullTimeoutMs: 1000,
        availabilityTtlMs: 0,
        read: { maxFileBytes: 1, maxTotalBytes: 1, maxFiles: 1, applyExclusions: true },
        collect: { maxFileBytes: 1, maxTotalBytes: 1, maxFiles: 1, applyExclusions: false },
      },
      logger({ level: 'silent' }),
    );
    for (const network of await sweeper.listNetworks().catch(() => [])) {
      if (network.name.startsWith(NETWORK)) {
        await sweeper.removeNetwork(network.id).catch(() => undefined);
      }
    }
    await db?.$disconnect();
  });

  it('starts a container and reports the project running', async () => {
    const { app } = buildApp();
    const cookie = await account(app);

    const project = await request(app)
      .post('/api/projects')
      .set('Cookie', cookie)
      .send({ name: 'Real Runtime' })
      .expect(201);
    const projectId = project.body.project.id as string;

    // A static site: the smallest image in the catalogue.
    await request(app)
      .put(`/api/projects/${projectId}/files/content`)
      .set('Cookie', cookie)
      .send({ path: 'index.html', content: '<h1>hello</h1>', encoding: 'utf8' })
      .expect(200);

    const started = await request(app)
      .post(`/api/projects/${projectId}/runtime/start`)
      .set('Cookie', cookie)
      .send({})
      .expect(200);

    const body = runtimeStateResponseSchema.parse(started.body);
    expect(body.runtime?.status).toBe('RUNNING');
    expect(body.runtime?.language).toBe('static');

    // The database says running. The daemon is the one that decides.
    const row = await db!.runtime.findFirstOrThrow();
    const inspected = await docker.getContainer(row.externalId!).inspect();
    expect(inspected.State.Running).toBe(true);

    // And the project's own file is in it, which is the point of the copy: the
    // database is the source of truth and the container is a copy of it.
    const contents = await readInContainer(row.externalId!, '/workspace/index.html');
    expect(contents).toContain('<h1>hello</h1>');

    // Stopping really stops it.
    const stopped = await request(app)
      .post(`/api/projects/${projectId}/runtime/stop`)
      .set('Cookie', cookie)
      .send({})
      .expect(200);

    expect(runtimeStateResponseSchema.parse(stopped.body).runtime?.status).toBe('STOPPED');
    const after = await docker.getContainer(row.externalId!).inspect();
    expect(after.State.Running).toBe(false);
  }, 600_000);

  it('leaves no container or network behind when the account is closed after a stop', async () => {
    // The order the load test's clean-up uses, which left one network per
    // project behind on the production stack.
    const { app, provider } = buildApp();
    const cookie = await account(app);
    const project = await request(app)
      .post('/api/projects')
      .set('Cookie', cookie)
      .send({ name: 'Closing' })
      .expect(201);
    const projectId = project.body.project.id as string;
    await request(app)
      .put(`/api/projects/${projectId}/files/content`)
      .set('Cookie', cookie)
      .send({ path: 'index.html', content: '<h1>bye</h1>', encoding: 'utf8' })
      .expect(200);
    await request(app)
      .post(`/api/projects/${projectId}/runtime/start`)
      .set('Cookie', cookie)
      .send({})
      .expect(200);
    const row = await db!.runtime.findFirstOrThrow();
    expect((await provider.listNetworks()).filter((n) => n.projectId === projectId)).toHaveLength(
      1,
    );

    await request(app)
      .post(`/api/projects/${projectId}/runtime/stop`)
      .set('Cookie', cookie)
      .send({})
      .expect(200);
    await request(app)
      .delete('/api/account')
      .set('Cookie', cookie)
      .send({ password: 'analytical-engine-1843', confirmUsername: 'ada' })
      .expect(200);

    const container = await docker
      .getContainer(row.externalId!)
      .inspect()
      .then(() => 'present')
      .catch(() => 'gone');
    expect(container).toBe('gone');
    expect((await provider.listNetworks()).filter((n) => n.projectId === projectId)).toEqual([]);
  }, 600_000);
});
