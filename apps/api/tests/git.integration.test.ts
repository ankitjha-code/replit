import request from 'supertest';
import { pino } from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { MinioStorageProvider } from '../src/storage/minio-storage.js';
import { UnavailableExecutionProvider } from '../src/execution/unavailable-provider.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import { hasGit, startGitServer, type GitServer } from './setup/git-server.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * History, branches and remotes through the real stack: real object storage,
 * real git objects, and a real git server speaking smart HTTP.
 * Requires `pnpm infra:up` and `git` on the machine running the tests.
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
const KEY = Buffer.alloc(32, 7).toString('base64');

afterAll(async () => {
  await db?.$disconnect();
});

/** A platform whose remotes may reach the test server on loopback over http. */
function platform(relaxed = true) {
  const hasher = new FakePasswordHasher();
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_PROJECT_CREATE_MAX: '100',
    RATE_LIMIT_GLOBAL_MAX: '10000',
    SECRETS_ENCRYPTION_KEY: KEY,
    ...(relaxed ? { GIT_REMOTE_ALLOW_HTTP: 'true', GIT_REMOTE_ALLOW_PRIVATE: 'true' } : {}),
  } as NodeJS.ProcessEnv);
  const auth = testAuth(
    db!,
    config,
    hasher,
    silentLogger(),
    new UnavailableExecutionProvider(),
    storage,
  );
  return testApp({ config, passwordHasher: hasher, auth });
}

async function workspace(app = platform(), name = 'ada') {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: `${name}@example.test`, username: name, password: 'analytical-engine-1843' })
    .expect(201);
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  const project = await request(app)
    .post('/api/projects')
    .set('Cookie', cookie)
    .send({ name: `P ${Math.random()}` })
    .expect(201);
  const base = `/api/projects/${project.body.project.id}`;

  const as = (method: 'get' | 'post' | 'put' | 'delete', path: string) =>
    request(app)[method](`${base}${path}`).set('Cookie', cookie);
  const write = (path: string, content: string) =>
    as('put', '/files/content').send({ path, content, encoding: 'utf8' }).expect(200);
  const read = async (path: string) =>
    (await as('get', '/files/content').query({ path }).expect(200)).body.content as string;
  const commit = (message: string) => as('post', '/git/commits').send({ message }).expect(201);

  return {
    app,
    cookie,
    base,
    projectId: project.body.project.id as string,
    as,
    write,
    read,
    commit,
  };
}

describe.skipIf(!db || !storageUp)('branches', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('creates, switches, commits on, and merges a branch, with the files following', async () => {
    const w = await workspace();
    await w.write('app.js', 'v1');
    await w.commit('first');

    const created = await w.as('post', '/git/branches').send({ name: 'feature/login' }).expect(201);
    expect(created.body.branches.map((b: { name: string }) => b.name)).toEqual([
      'feature/login',
      'main',
    ]);
    expect(created.body.branch).toBe('main');

    await w.as('post', `/git/branches/${encodeURIComponent('feature/login')}/switch`).expect(200);
    await w.write('app.js', 'v2 with login');
    await w.commit('login');

    // Back on main, the file is what main has.
    const back = await w.as('post', '/git/branches/main/switch').expect(200);
    expect(back.body.branch).toBe('main');
    expect(await w.read('app.js')).toBe('v1');

    const merged = await w.as('post', '/git/merge').send({ branch: 'feature/login' }).expect(200);
    expect(merged.body.merge.outcome).toBe('fastForward');
    expect(await w.read('app.js')).toBe('v2 with login');
    expect(merged.body.state.hasUncommittedChanges).toBe(false);
  });

  it('refuses to switch or merge over uncommitted work, and loses nothing', async () => {
    const w = await workspace();
    await w.write('app.js', 'v1');
    await w.commit('first');
    await w.as('post', '/git/branches').send({ name: 'other' }).expect(201);
    await w.write('app.js', 'unsaved thought');

    const refused = await w.as('post', '/git/branches/other/switch').expect(412);
    expect(refused.body.error.message).toMatch(/Commit your changes/);
    await w.as('post', '/git/merge').send({ branch: 'other' }).expect(412);
    expect(await w.read('app.js')).toBe('unsaved thought');
  });

  it('reports a conflict with the file named, and changes nothing', async () => {
    const w = await workspace();
    await w.write('app.js', 'base');
    await w.commit('base');
    await w.as('post', '/git/branches').send({ name: 'theirs' }).expect(201);

    await w.write('app.js', 'ours');
    await w.commit('ours');
    await w.as('post', '/git/branches/theirs/switch').expect(200);
    await w.write('app.js', 'theirs');
    await w.commit('theirs');
    await w.as('post', '/git/branches/main/switch').expect(200);

    const conflict = await w.as('post', '/git/merge').send({ branch: 'theirs' }).expect(409);
    expect(conflict.body.error.message).toContain('app.js');
    expect(await w.read('app.js')).toBe('ours');
  });

  it('will not delete the branch the project is on, and refuses bad names', async () => {
    const w = await workspace();
    await w.write('a', 'a');
    await w.commit('first');
    await w.as('delete', '/git/branches/main').expect(412);
    for (const name of ['../x', 'a..b', '-x', 'x.lock', 'with space']) {
      await w.as('post', '/git/branches').send({ name }).expect(422);
    }
  });
});

describe.skipIf(!db || !storageUp || !hasGit())('remotes', () => {
  let server: GitServer;

  beforeEach(async () => {
    await resetDatabase(db!);
  });

  afterEach(async () => {
    await server?.close();
  });

  it('pushes to a real git server, which then has the commit', async () => {
    server = await startGitServer();
    server.create('shop.git');
    const w = await workspace();
    await w.write('index.html', '<h1>hello</h1>');
    const committed = await w.commit('first');
    const oid = committed.body.commits[0].oid as string;

    await w
      .as('put', '/git/remote')
      .send({ url: server.url('shop.git') })
      .expect(200);
    await w.as('post', '/git/push').send({}).expect(200);

    expect(server.git('shop.git', 'rev-parse', 'refs/heads/main')).toBe(oid);
    expect(server.git('shop.git', 'show', 'main:index.html')).toBe('<h1>hello</h1>');

    const remote = await w.as('get', '/git/remote').expect(200);
    expect(remote.body.remote.lastPushedAt).not.toBeNull();
  });

  it('imports a repository into an empty project by pulling', async () => {
    server = await startGitServer();
    server.create('shop.git');
    const first = await workspace(platform(), 'ada');
    await first.write('README.md', '# shop');
    await first.write('src/app.js', 'console.log(1)');
    await first.commit('initial');
    await first
      .as('put', '/git/remote')
      .send({ url: server.url('shop.git') })
      .expect(200);
    await first.as('post', '/git/push').send({}).expect(200);

    const second = await workspace(platform(), 'bob');
    await second
      .as('put', '/git/remote')
      .send({ url: server.url('shop.git') })
      .expect(200);
    const pulled = await second.as('post', '/git/pull').expect(200);

    expect(pulled.body.outcome).toBe('imported');
    expect(pulled.body.state.commits[0].message).toBe('initial');
    expect(await second.read('src/app.js')).toBe('console.log(1)');
  });

  it('pulls new commits as a fast-forward, and refuses a push that would lose them', async () => {
    server = await startGitServer();
    server.create('shop.git');
    const ada = await workspace(platform(), 'ada');
    await ada.write('a.txt', 'one');
    await ada.commit('one');
    await ada
      .as('put', '/git/remote')
      .send({ url: server.url('shop.git') })
      .expect(200);
    await ada.as('post', '/git/push').send({}).expect(200);

    const bob = await workspace(platform(), 'bob');
    await bob
      .as('put', '/git/remote')
      .send({ url: server.url('shop.git') })
      .expect(200);
    await bob.as('post', '/git/pull').expect(200);
    await bob.write('a.txt', 'two');
    await bob.commit('two');
    await bob.as('post', '/git/push').send({}).expect(200);

    // Ada is now behind. Pushing something of her own is refused, not forced.
    await ada.write('b.txt', 'ada');
    await ada.commit('ada');
    const refused = await ada.as('post', '/git/push').send({}).expect(409);
    expect(refused.body.error.message).toMatch(/Pull first/);

    // Pulling merges Bob's work in.
    const pulled = await ada.as('post', '/git/pull').expect(200);
    expect(pulled.body.outcome).toBe('merged');
    expect(await ada.read('a.txt')).toBe('two');
    expect(await ada.read('b.txt')).toBe('ada');
    await ada.as('post', '/git/push').send({}).expect(200);
  });

  it('sends the stored token and never returns it', async () => {
    server = await startGitServer({ requireAuth: 'ada:s3cret-token' });
    server.create('private.git');
    const w = await workspace();
    await w.write('a', 'a');
    await w.commit('first');

    await w
      .as('put', '/git/remote')
      .send({ url: server.url('private.git'), username: 'ada', token: 'wrong' })
      .expect(200);
    const refused = await w.as('post', '/git/push').send({}).expect(412);
    expect(refused.body.error.message).toMatch(/credentials/);

    const set = await w
      .as('put', '/git/remote')
      .send({ url: server.url('private.git'), username: 'ada', token: 's3cret-token' })
      .expect(200);
    expect(set.body.remote).toMatchObject({ hasToken: true, username: 'ada' });
    expect(JSON.stringify(set.body)).not.toContain('s3cret');

    await w.as('post', '/git/push').send({}).expect(200);
    expect(server.authorizations).toContain(
      `Basic ${Buffer.from('ada:s3cret-token').toString('base64')}`,
    );

    const shown = await w.as('get', '/git/remote').expect(200);
    expect(JSON.stringify(shown.body)).not.toContain('s3cret');
    const row = await db!.projectGitRemote.findUniqueOrThrow({ where: { projectId: w.projectId } });
    expect(Buffer.from(row.token!).toString()).not.toContain('s3cret');

    // Changing the address keeps the token unless it is replaced.
    const moved = await w
      .as('put', '/git/remote')
      .send({ url: server.url('private.git') })
      .expect(200);
    expect(moved.body.remote.hasToken).toBe(true);
  });

  it('refuses loopback and plain http by default, before anything is sent', async () => {
    server = await startGitServer();
    server.create('shop.git');
    const w = await workspace(platform(false));
    await w.write('a', 'a');
    await w.commit('first');

    const refused = await w
      .as('put', '/git/remote')
      .send({ url: server.url('shop.git') })
      .expect(422);
    expect(JSON.stringify(refused.body)).toMatch(/https/);

    // An https name that resolves to loopback is refused at connection time.
    await w.as('put', '/git/remote').send({ url: 'https://localhost:1/shop.git' }).expect(200);
    const push = await w.as('post', '/git/push').send({}).expect(412);
    expect(push.body.error.message).toMatch(/private address/);
    expect(server.authorizations).toHaveLength(0);
  });

  it('lets only the owner set the remote, and editors use it', async () => {
    server = await startGitServer();
    const app = platform();
    const owner = await workspace(app, 'ada');
    const editor = await request(app)
      .post('/api/auth/register')
      .send({ email: 'eddie@example.test', username: 'eddie', password: 'analytical-engine-1843' })
      .expect(201);
    const editorCookie = (editor.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const ed = await db!.user.findUniqueOrThrow({ where: { username: 'eddie' } });
    await db!.projectMember.create({
      data: { projectId: owner.projectId, userId: ed.id, role: 'EDITOR' },
    });

    await request(app)
      .put(`${owner.base}/git/remote`)
      .set('Cookie', editorCookie)
      .send({ url: server.url('x.git') })
      .expect(403);
    await request(app).get(`${owner.base}/git/remote`).set('Cookie', editorCookie).expect(200);
  });
});
