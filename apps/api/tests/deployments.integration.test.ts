import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { pino } from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { ArtifactStore } from '../src/deploy/artifact-store.js';
import { createDeploymentServer, type DeploymentServer } from '../src/deploy/deployment-server.js';
import { UnavailableExecutionProvider } from '../src/execution/unavailable-provider.js';
import { MinioStorageProvider } from '../src/storage/minio-storage.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import { FakeDeploymentProvider } from './setup/deployment.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * Deployments through the real stack: real database, real object storage, the
 * real public listener, and a real HTTP upstream behind a fake build backend.
 * What is fake is only the container runtime; everything the platform decides
 * — states, releases, rollback, what is served to whom — is the real code.
 * Requires `pnpm infra:up`.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;
const SUFFIX = 'app.example.test';

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

const servers: { close(): Promise<void> }[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

afterAll(async () => {
  await db?.$disconnect();
});

/** A stand-in for a deployed program: answers every request with `body`. */
async function upstream(body: string): Promise<{ host: string; port: number }> {
  const server: Server = createServer((_req, res) => res.end(body));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
  return { host: '127.0.0.1', port: (server.address() as { port: number }).port };
}

async function platform(options: { secret?: boolean } = {}) {
  const hasher = new FakePasswordHasher();
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_PROJECT_CREATE_MAX: '100',
    RATE_LIMIT_GLOBAL_MAX: '10000',
    DEPLOYMENT_HOST_SUFFIX: SUFFIX,
    ...(options.secret ? { SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64') } : {}),
  } as NodeJS.ProcessEnv);
  const provider = new FakeDeploymentProvider();
  const auth = testAuth(
    db!,
    config,
    hasher,
    silentLogger(),
    new UnavailableExecutionProvider(),
    storage,
    undefined,
    undefined,
    provider,
  );
  const app = testApp({ config, passwordHasher: hasher, auth });

  const artifacts = new ArtifactStore(storage, { maxCacheBytes: 1_000_000 }, silentLogger());
  auth.deployments.useArtifacts(artifacts);
  const listener: DeploymentServer = createDeploymentServer({
    deployments: auth.deployments,
    domains: auth.domains,
    artifacts,
    log: silentLogger(),
  });
  await listener.listen(0, '127.0.0.1');
  servers.push({ close: () => listener.close() });
  const port = (listener.server.address() as { port: number }).port;

  const register = async (name: string) => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: `${name}@example.test`, username: name, password: 'analytical-engine-1843' })
      .expect(201);
    return (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  };

  const cookie = await register('ada');
  const project = await request(app)
    .post('/api/projects')
    .set('Cookie', cookie)
    .send({ name: 'Shop' })
    .expect(201);
  const projectId = project.body.project.id as string;
  const base = `/api/projects/${projectId}`;
  const as = (method: 'get' | 'post' | 'put' | 'delete', path: string, who = cookie) =>
    request(app)[method](`${base}${path}`).set('Cookie', who);

  await as('put', '/files/content')
    .send({ path: 'package.json', content: '{"name":"shop"}', encoding: 'utf8' })
    .expect(200);
  await as('put', '/files/content')
    .send({ path: 'index.js', content: 'console.log(1)', encoding: 'utf8' })
    .expect(200);

  /** What a visitor to a hostname gets from the public listener. */
  const visit = (host: string) =>
    request(`http://127.0.0.1:${String(port)}`)
      .get('/')
      .set('Host', host);
  const hostOf = (address: string) => new URL(address).host;

  return { app, auth, provider, projectId, base, as, register, visit, hostOf, cookie };
}

const STATIC = {
  target: 'STATIC',
  buildCommand: null,
  outputDirectory: 'dist',
  startCommand: null,
};
const SERVER = {
  target: 'SERVER',
  buildCommand: null,
  outputDirectory: null,
  startCommand: 'node index.js',
};

describe.skipIf(!db || !storageUp)('deployments', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  describe('configuration', () => {
    it('refuses to deploy before being told how', async () => {
      const p = await platform();
      const res = await p.as('post', '/deployments').send({}).expect(412);
      expect(res.body.error.message).toMatch(/built and started/);
      expect(p.provider.builds).toHaveLength(0);
    });

    it('refuses a configuration that cannot mean anything', async () => {
      const p = await platform();
      await p
        .as('put', '/deployments/config')
        .send({ ...STATIC, outputDirectory: null })
        .expect(422);
      await p
        .as('put', '/deployments/config')
        .send({ ...SERVER, startCommand: null })
        .expect(422);
    });
  });

  describe('a static site', () => {
    it('is built, stored, and served on the project address and the release address', async () => {
      const p = await platform();
      await p.as('put', '/deployments/config').send(STATIC).expect(200);

      const created = await p.as('post', '/deployments').send({ note: 'first' }).expect(201);
      const release = created.body.deployment;
      expect(release).toMatchObject({ status: 'RUNNING', fileCount: 1, note: 'first' });
      // A static site needs nothing running: the build workload is gone.
      expect(p.provider.destroyed).toEqual(['workload-1']);

      expect((await p.visit(p.hostOf(release.url)).expect(200)).text).toBe('<h1>static v1</h1>');
      expect((await p.visit(p.hostOf(release.releaseUrl)).expect(200)).text).toBe(
        '<h1>static v1</h1>',
      );
    });

    it('is built from a frozen copy, not from files edited afterwards', async () => {
      const p = await platform();
      await p.as('put', '/deployments/config').send(STATIC).expect(200);
      await p.as('post', '/deployments').send({}).expect(201);

      const built = p.provider.builds[0]!.entries.find((e) => e.path === 'index.js');
      await p
        .as('put', '/files/content')
        .send({ path: 'index.js', content: 'changed later', encoding: 'utf8' })
        .expect(200);
      expect(Buffer.from((built as { content: Uint8Array }).content).toString()).toBe(
        'console.log(1)',
      );
    });

    it('refuses to publish a build that produced nothing', async () => {
      const p = await platform();
      p.provider.output = [];
      await p.as('put', '/deployments/config').send(STATIC).expect(200);
      const res = await p.as('post', '/deployments').send({}).expect(412);
      expect(res.body.error.message).toMatch(/left nothing/);

      const state = await p.as('get', '/deployments').expect(200);
      expect(state.body.deployments[0].status).toBe('FAILED');
      expect(state.body.liveId).toBeNull();
    });
  });

  describe('a server', () => {
    it('is started with the project configuration and proxied to once it answers', async () => {
      const p = await platform({ secret: true });
      p.provider.upstream = await upstream('hello from the server');
      await p.as('put', '/variables').send({ key: 'MODE', value: 'production' }).expect(200);
      await p.as('put', '/secrets').send({ key: 'API_TOKEN', value: 's3cret' }).expect(200);
      await p.as('put', '/deployments/config').send(SERVER).expect(200);

      const created = await p.as('post', '/deployments').send({}).expect(201);
      expect(created.body.deployment.status).toBe('RUNNING');

      const served = p.provider.served[0]!;
      expect(served.startCommand).toBe('node index.js');
      expect(served.environment).toMatchObject({ MODE: 'production', API_TOKEN: 's3cret' });
      // Nothing of the platform's own configuration reaches a deployed program.
      expect(Object.keys(served.environment)).not.toContain('DATABASE_URL');
      expect(Object.keys(served.environment)).not.toContain('SECRETS_ENCRYPTION_KEY');

      expect((await p.visit(p.hostOf(created.body.deployment.url)).expect(200)).text).toBe(
        'hello from the server',
      );
    });

    it('records a crash as a failure, with the reason in its log', async () => {
      const p = await platform();
      p.provider.upstream = await upstream('ok');
      await p.as('put', '/deployments/config').send(SERVER).expect(200);
      const created = await p.as('post', '/deployments').send({}).expect(201);

      p.provider.exit('workload-1', 137);

      await expect
        .poll(async () => (await p.as('get', '/deployments')).body.deployments[0].status)
        .toBe('FAILED');
      await p.auth.logs.flush();
      const lines = await db!.projectLogLine.findMany({
        where: { projectId: p.projectId, sourceId: created.body.deployment.id },
      });
      expect(lines.map((l) => l.message)).toContain('This deployment exited with code 137.');
    });

    it('is stopped on request, and a stop is not recorded as a crash', async () => {
      const p = await platform();
      p.provider.upstream = await upstream('ok');
      await p.as('put', '/deployments/config').send(SERVER).expect(200);
      const created = await p.as('post', '/deployments').send({}).expect(201);
      const id = created.body.deployment.id as string;

      const stopped = await p.as('post', `/deployments/${id}/stop`).send({}).expect(200);
      expect(stopped.body.deployment.status).toBe('STOPPED');
      p.provider.exit('workload-1', 0);

      expect((await p.as('get', '/deployments')).body.deployments[0].status).toBe('STOPPED');
      expect((await p.visit(p.hostOf(created.body.deployment.url))).status).not.toBe(200);
    });
  });

  describe('releases', () => {
    it('a failed build leaves the previous release serving', async () => {
      const p = await platform();
      await p.as('put', '/deployments/config').send(STATIC).expect(200);
      const first = await p.as('post', '/deployments').send({ note: 'good' }).expect(201);

      p.provider.failBuild = 'npm ERR! missing script: build';
      await p.as('post', '/deployments').send({ note: 'broken' }).expect(500);

      const state = await p.as('get', '/deployments').expect(200);
      expect(state.body.liveId).toBe(first.body.deployment.id);
      expect((await p.visit(p.hostOf(first.body.deployment.url)).expect(200)).text).toBe(
        '<h1>static v1</h1>',
      );

      const failed = state.body.deployments.find((d: { note: string }) => d.note === 'broken');
      const log = await p.as('get', `/deployments/${failed.id}/log`).expect(200);
      expect(JSON.stringify(log.body)).toContain('missing script: build');
    });

    it('rolls a static site back without rebuilding it', async () => {
      const p = await platform();
      await p.as('put', '/deployments/config').send(STATIC).expect(200);
      const v1 = await p.as('post', '/deployments').send({ note: 'v1' }).expect(201);

      p.provider.output = [
        { path: 'index.html', content: new TextEncoder().encode('<h1>static v2</h1>') },
      ];
      const v2 = await p.as('post', '/deployments').send({ note: 'v2' }).expect(201);
      expect((await p.visit(p.hostOf(v2.body.deployment.url))).text).toBe('<h1>static v2</h1>');
      const buildsBefore = p.provider.builds.length;

      const back = await p
        .as('post', `/deployments/${v1.body.deployment.id as string}/rollback`)
        .send({})
        .expect(202);

      expect(back.body.deployment).toMatchObject({
        status: 'RUNNING',
        rolledBackFromId: v1.body.deployment.id,
      });
      expect(p.provider.builds).toHaveLength(buildsBefore);
      expect((await p.visit(p.hostOf(v2.body.deployment.url))).text).toBe('<h1>static v1</h1>');

      // The release that is live now cannot be "rolled back" to.
      await p
        .as('post', `/deployments/${back.body.deployment.id as string}/rollback`)
        .send({})
        .expect(412);
    });
  });

  describe('deploying again and again', () => {
    it('can keep deploying a server, however many times', async () => {
      // Every release keeps its own address, so a superseded server release is
      // still RUNNING — and every RUNNING release counts as a live deployment.
      const p = await platform();
      p.provider.upstream = await upstream('ok');
      await p.as('put', '/deployments/config').send(SERVER).expect(200);
      for (let release = 1; release <= 6; release += 1) {
        const res = await p.as('post', '/deployments').send({ note: `v${String(release)}` });
        expect([res.status, res.body.error?.message ?? 'ok']).toEqual([201, 'ok']);
      }

      // Only the newest is still running; the rest were stopped as they were replaced.
      const state = await p.as('get', '/deployments').expect(200);
      const running = state.body.deployments.filter(
        (d: { status: string }) => d.status === 'RUNNING',
      );
      expect(running.map((d: { note: string }) => d.note)).toEqual(['v6']);
      expect(p.provider.stopped).toHaveLength(5);
    });

    it('can keep publishing a static site, and old releases keep their own addresses', async () => {
      const p = await platform();
      await p.as('put', '/deployments/config').send(STATIC).expect(200);
      let first: { releaseUrl: string } | undefined;
      for (let release = 1; release <= 6; release += 1) {
        const res = await p
          .as('post', '/deployments')
          .send({ note: `v${String(release)}` })
          .expect(201);
        first ??= res.body.deployment;
      }
      expect((await p.visit(p.hostOf(first!.releaseUrl)).expect(200)).text).toBe(
        '<h1>static v1</h1>',
      );
    });
  });

  describe('the disk limit', () => {
    it('stops a server deployment that wrote past its limit, with the reason in its log', async () => {
      const p = await platform();
      p.provider.upstream = await upstream('ok');
      await p.as('put', '/deployments/config').send(SERVER).expect(200);
      const created = await p.as('post', '/deployments').send({}).expect(201);
      p.provider.disk.set('workload-1', 3 * 1024 * 1024 * 1024);

      const report = await p.auth.deployments.enforceDiskLimit(2 * 1024 * 1024 * 1024);
      await p.auth.logs.flush();

      expect(report).toEqual({ checked: 1, stopped: 1 });
      expect((await p.as('get', '/deployments')).body.deployments[0].status).toBe('STOPPED');
      const lines = await db!.projectLogLine.findMany({
        where: { projectId: p.projectId, sourceId: created.body.deployment.id },
      });
      expect(lines.map((l) => l.message).join('\n')).toMatch(/over its 2048 MB limit/);
    });
  });

  describe('who may do what', () => {
    it('lets an editor read deployments but not deploy', async () => {
      const p = await platform();
      await p.as('put', '/deployments/config').send(STATIC).expect(200);
      const editorCookie = await p.register('grace');
      const grace = await db!.user.findUniqueOrThrow({ where: { username: 'grace' } });
      await db!.projectMember.create({
        data: { projectId: p.projectId, userId: grace.id, role: 'EDITOR' },
      });

      await p.as('get', '/deployments', editorCookie).expect(200);
      await p.as('post', '/deployments', editorCookie).send({}).expect(403);
      expect(p.provider.builds).toHaveLength(0);
    });
  });

  describe('deleting the project', () => {
    it('takes its deployments with it, and serves nothing afterwards', async () => {
      const p = await platform();
      p.provider.upstream = await upstream('ok');
      await p.as('put', '/deployments/config').send(SERVER).expect(200);
      const created = await p.as('post', '/deployments').send({}).expect(201);

      await request(p.app)
        .delete(`/api/projects/${p.projectId}`)
        .set('Cookie', p.cookie)
        .expect(204);

      expect(p.provider.destroyed).toContain('workload-1');
      expect((await p.visit(p.hostOf(created.body.deployment.url))).status).not.toBe(200);
    });
  });
});
