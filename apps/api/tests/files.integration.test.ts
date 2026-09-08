import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileContentResponseSchema, fileTreeResponseSchema } from '@platform/shared';
import { loadEnv } from '../src/config/env.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * Project files over real HTTP against the real database.
 *
 * Requires `pnpm infra:up`. The path rules are the security-relevant part and
 * are exercised here against the real stack, not only as pure functions.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

function buildApp(overrides: Record<string, string> = {}) {
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_PROJECT_CREATE_MAX: '100',
    ...overrides,
  } as NodeJS.ProcessEnv);

  const auth = testAuth(db!, config, new FakePasswordHasher(), silentLogger());
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

async function project(app: App, cookie: string, name = 'Files'): Promise<string> {
  const res = await request(app)
    .post('/api/projects')
    .set('Cookie', cookie)
    .send({ name })
    .expect(201);
  return res.body.project.id as string;
}

/** A signed-in owner with an empty project. */
async function workspace(overrides: Record<string, string> = {}) {
  const built = buildApp(overrides);
  const cookie = await account(built.app, 'ada');
  const projectId = await project(built.app, cookie);
  return { ...built, cookie, projectId };
}

const files = (app: App, projectId: string, cookie: string) => ({
  tree: () => request(app).get(`/api/projects/${projectId}/files`).set('Cookie', cookie),
  read: (path: string) =>
    request(app)
      .get(`/api/projects/${projectId}/files/content`)
      .query({ path })
      .set('Cookie', cookie),
  write: (body: Record<string, unknown>) =>
    request(app).put(`/api/projects/${projectId}/files/content`).set('Cookie', cookie).send(body),
  mkdir: (path: string) =>
    request(app)
      .post(`/api/projects/${projectId}/files/directory`)
      .set('Cookie', cookie)
      .send({ path }),
  move: (from: string, to: string) =>
    request(app)
      .post(`/api/projects/${projectId}/files/move`)
      .set('Cookie', cookie)
      .send({ from, to }),
  remove: (path: string) =>
    request(app).delete(`/api/projects/${projectId}/files`).query({ path }).set('Cookie', cookie),
  search: (q: string) =>
    request(app).get(`/api/projects/${projectId}/files/search`).query({ q }).set('Cookie', cookie),
});

afterAll(async () => {
  await db?.$disconnect();
});

describe.skipIf(!db)('writing and reading files', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('creates a file and reads it back', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'index.js', content: 'console.log(1)\n' }).expect(200);

    const read = await api.read('index.js').expect(200);
    expect(() => fileContentResponseSchema.parse(read.body)).not.toThrow();
    expect(read.body.content).toBe('console.log(1)\n');
    expect(read.body.encoding).toBe('utf8');
  });

  it('persists the bytes, a size and a checksum', async () => {
    const { app, projectId, cookie } = await workspace();
    await files(app, projectId, cookie).write({ path: 'a.txt', content: 'hello' }).expect(200);

    const stored = await db!.projectFile.findFirst({ where: { path: 'a.txt' } });
    expect(Buffer.from(stored!.content!).toString('utf8')).toBe('hello');
    expect(stored?.size).toBe(5);
    expect(stored?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('overwrites an existing file and increments its version', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    const first = await api.write({ path: 'a.txt', content: 'one' }).expect(200);
    const second = await api.write({ path: 'a.txt', content: 'two' }).expect(200);

    expect(second.body.entry.version).toBe(first.body.entry.version + 1);
    expect((await api.read('a.txt')).body.content).toBe('two');
  });

  it('records the parent directory so a listing needs no path arithmetic', async () => {
    const { app, projectId, cookie } = await workspace();
    await files(app, projectId, cookie).write({ path: 'src/lib/a.ts', content: 'x' }).expect(200);

    const stored = await db!.projectFile.findFirst({ where: { path: 'src/lib/a.ts' } });
    expect(stored?.parentPath).toBe('src/lib');
    expect(stored?.name).toBe('a.ts');
  });

  it('round-trips binary content without corrupting it', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    // Bytes that are not valid UTF-8. A text round trip would replace them.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    await api
      .write({ path: 'logo.png', content: bytes.toString('base64'), encoding: 'base64' })
      .expect(200);

    const read = await api.read('logo.png').expect(200);
    expect(read.body.encoding).toBe('base64');
    expect(Buffer.from(read.body.content, 'base64').equals(bytes)).toBe(true);
    expect(read.body.entry.isBinary).toBe(true);
  });

  it('treats valid UTF-8 as text, including non-Latin scripts', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'notes.md', content: '# 日本語 café\n' }).expect(200);
    const read = await api.read('notes.md').expect(200);

    expect(read.body.entry.isBinary).toBe(false);
    expect(read.body.content).toBe('# 日本語 café\n');
  });

  it('stores an empty file rather than refusing it', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'empty.txt', content: '' }).expect(200);
    expect((await api.read('empty.txt')).body.entry.size).toBe(0);
  });

  it('answers 404 for a file that does not exist', async () => {
    const { app, projectId, cookie } = await workspace();
    await files(app, projectId, cookie).read('nope.txt').expect(404);
  });
});

describe.skipIf(!db)('path rules', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('refuses every attempt to escape the project root', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    const attempts = [
      '../outside.txt',
      'src/../../etc/passwd',
      '/etc/passwd',
      'C:/Windows/system.ini',
      'a/./b.txt',
      '..',
      'src\\..\\..\\x',
    ];

    for (const path of attempts) {
      const res = await api.write({ path, content: 'x' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }

    // Nothing reached the table, so nothing could later be written outside a
    // container's project directory.
    expect(await db!.projectFile.count()).toBe(0);
  });

  it('refuses a null byte in a path', async () => {
    const { app, projectId, cookie } = await workspace();
    await files(app, projectId, cookie).write({ path: 'a\u0000b.txt', content: 'x' }).expect(422);
  });

  it('normalises duplicate separators before storing', async () => {
    const { app, projectId, cookie } = await workspace();
    await files(app, projectId, cookie).write({ path: 'src//a.txt', content: 'x' }).expect(200);

    expect(await db!.projectFile.findFirst({ where: { path: 'src/a.txt' } })).not.toBeNull();
  });

  it('refuses a path whose parent is a file', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'notes.txt', content: 'x' }).expect(200);

    // Representable in a table of paths, impossible on any real filesystem.
    // Refusing here beats failing when the project is materialised later.
    const res = await api.write({ path: 'notes.txt/inner.js', content: 'x' }).expect(409);
    expect(res.body.error.message).toContain('notes.txt');
  });

  it('refuses a file where a directory already is', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.mkdir('src').expect(201);
    await api.write({ path: 'src', content: 'x' }).expect(409);
  });
});

describe.skipIf(!db)('directories', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('creates an empty directory', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    const res = await api.mkdir('src').expect(201);
    expect(res.body.entry.type).toBe('DIRECTORY');
    expect(res.body.entry.size).toBe(0);

    // An empty directory is something people make on purpose, so it has a row
    // rather than being implied by the paths of files inside it.
    const tree = await api.tree().expect(200);
    expect(tree.body.entries.map((e: { path: string }) => e.path)).toEqual(['src']);
  });

  it('refuses to create the same directory twice', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.mkdir('src').expect(201);
    await api.mkdir('src').expect(409);
  });

  it('reading a directory is a bad request, not a not-found', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.mkdir('src').expect(201);
    await api.read('src').expect(400);
  });
});

describe.skipIf(!db)('the tree', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('lists every entry sorted by path, with a total size', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'src/b.ts', content: 'bb' }).expect(200);
    await api.write({ path: 'a.ts', content: 'a' }).expect(200);
    await api.mkdir('docs').expect(201);

    const res = await api.tree().expect(200);
    expect(() => fileTreeResponseSchema.parse(res.body)).not.toThrow();
    // "src" appears as an entry of its own: writing into a directory creates
    // it, the way mkdir -p would.
    expect(res.body.entries.map((e: { path: string }) => e.path)).toEqual([
      'a.ts',
      'docs',
      'src',
      'src/b.ts',
    ]);
    // Directories contribute nothing to the total.
    expect(res.body.totalBytes).toBe(3);
  });

  it('never includes file content', async () => {
    // A tree of a hundred files would otherwise transfer every byte of every
    // one of them to draw a sidebar.
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'secret.txt', content: 'the content' }).expect(200);
    const res = await api.tree().expect(200);

    expect(JSON.stringify(res.body)).not.toContain('the content');
    expect(res.body.entries[0]).not.toHaveProperty('content');
  });

  it('creates the directories a nested write implies', async () => {
    // Otherwise the explorer would show a folder with no entry behind it:
    // visible in the tree, impossible to rename or delete.
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'src/deep/nested/a.ts', content: 'x' }).expect(200);

    const res = await api.tree().expect(200);
    expect(res.body.entries.map((e: { path: string }) => e.path)).toEqual([
      'src',
      'src/deep',
      'src/deep/nested',
      'src/deep/nested/a.ts',
    ]);
    expect(res.body.entries[0].type).toBe('DIRECTORY');
  });

  it('reuses a directory that already exists rather than failing', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.mkdir('src').expect(201);
    await api.write({ path: 'src/a.ts', content: 'x' }).expect(200);
    await api.write({ path: 'src/b.ts', content: 'x' }).expect(200);

    const res = await api.tree().expect(200);
    expect(res.body.entries.filter((e: { path: string }) => e.path === 'src')).toHaveLength(1);
  });

  it('is empty for a new project', async () => {
    const { app, projectId, cookie } = await workspace();
    const res = await files(app, projectId, cookie).tree().expect(200);
    expect(res.body.entries).toEqual([]);
  });
});

describe.skipIf(!db)('moving and renaming', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('renames a file', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'old.txt', content: 'kept' }).expect(200);
    await api.move('old.txt', 'new.txt').expect(200);

    await api.read('old.txt').expect(404);
    expect((await api.read('new.txt')).body.content).toBe('kept');
  });

  it('moves a file into a directory', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'a.txt', content: 'x' }).expect(200);
    await api.mkdir('src').expect(201);
    await api.move('a.txt', 'src/a.txt').expect(200);

    const stored = await db!.projectFile.findFirst({ where: { path: 'src/a.txt' } });
    expect(stored?.parentPath).toBe('src');
  });

  it('moves a directory and everything under it', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'src/a.ts', content: 'a' }).expect(200);
    await api.write({ path: 'src/deep/b.ts', content: 'b' }).expect(200);
    await api.mkdir('src/empty').expect(201);

    await api.move('src', 'lib').expect(200);

    const tree = await api.tree().expect(200);
    expect(tree.body.entries.map((e: { path: string }) => e.path)).toEqual([
      'lib',
      'lib/a.ts',
      'lib/deep',
      'lib/deep/b.ts',
      'lib/empty',
    ]);
    expect((await api.read('lib/deep/b.ts')).body.content).toBe('b');
  });

  it('refuses to move a directory inside itself', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'src/a.ts', content: 'a' }).expect(200);

    // The rewritten descendants would sit under a path that no longer exists.
    const res = await api.move('src', 'src/inner').expect(400);
    expect(res.body.error.message).toContain('inside itself');
  });

  it('does not treat a name prefix as containment', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.mkdir('src').expect(201);
    // "srcfile" is not inside "src", so this is an ordinary move.
    await api.move('src', 'srcfile').expect(200);
  });

  it('refuses to overwrite something at the destination', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'a.txt', content: 'a' }).expect(200);
    await api.write({ path: 'b.txt', content: 'b' }).expect(200);

    await api.move('a.txt', 'b.txt').expect(409);
    expect((await api.read('b.txt')).body.content).toBe('b');
  });

  it('refuses to move something that is not there', async () => {
    const { app, projectId, cookie } = await workspace();
    await files(app, projectId, cookie).move('nope.txt', 'other.txt').expect(404);
  });

  it('refuses a destination that escapes the project', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'a.txt', content: 'x' }).expect(200);
    await api.move('a.txt', '../escaped.txt').expect(422);
  });

  it('leaves the tree untouched when a move fails partway', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'src/a.ts', content: 'a' }).expect(200);
    await api.write({ path: 'lib', content: 'occupied' }).expect(200);

    await api.move('src', 'lib').expect(409);

    // Nothing half-moved: the subtree rewrite is one transaction.
    expect((await api.read('src/a.ts')).body.content).toBe('a');
    expect((await api.read('lib')).body.content).toBe('occupied');
  });
});

describe.skipIf(!db)('deleting', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('removes a file', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'a.txt', content: 'x' }).expect(200);
    await api.remove('a.txt').expect(204);
    await api.read('a.txt').expect(404);
  });

  it('removes a directory and everything under it', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'src/a.ts', content: 'a' }).expect(200);
    await api.write({ path: 'src/deep/b.ts', content: 'b' }).expect(200);
    await api.write({ path: 'keep.ts', content: 'k' }).expect(200);

    await api.remove('src').expect(204);

    const tree = await api.tree().expect(200);
    expect(tree.body.entries.map((e: { path: string }) => e.path)).toEqual(['keep.ts']);
  });

  it('does not remove a sibling whose name shares a prefix', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.mkdir('src').expect(201);
    await api.write({ path: 'srcfile.ts', content: 'x' }).expect(200);

    await api.remove('src').expect(204);
    await api.read('srcfile.ts').expect(200);
  });

  it('answers 404 for something that is not there', async () => {
    const { app, projectId, cookie } = await workspace();
    await files(app, projectId, cookie).remove('nope.txt').expect(404);
  });

  it('removes every file when the project is deleted', async () => {
    const { app, projectId, cookie } = await workspace();
    await files(app, projectId, cookie).write({ path: 'a.txt', content: 'x' }).expect(200);

    await request(app).delete(`/api/projects/${projectId}`).set('Cookie', cookie).expect(204);
    expect(await db!.projectFile.count()).toBe(0);
  });
});

describe.skipIf(!db)('concurrent writes', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('accepts a write that names the version it is replacing', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    const created = await api.write({ path: 'a.txt', content: 'one' }).expect(200);
    await api
      .write({ path: 'a.txt', content: 'two', expectedVersion: created.body.entry.version })
      .expect(200);
  });

  it('refuses a write whose version is stale', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    const created = await api.write({ path: 'a.txt', content: 'one' }).expect(200);
    const stale = created.body.entry.version;

    // Someone else saved in between.
    await api.write({ path: 'a.txt', content: 'theirs' }).expect(200);

    const res = await api
      .write({ path: 'a.txt', content: 'mine', expectedVersion: stale })
      .expect(409);
    expect(res.body.error.message).toContain('changed since you opened it');

    // The other person's work is still there.
    expect((await api.read('a.txt')).body.content).toBe('theirs');
  });

  it('lets exactly one of several racing writes win', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    const created = await api.write({ path: 'a.txt', content: 'base' }).expect(200);
    const version = created.body.entry.version;

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        api.write({ path: 'a.txt', content: `writer-${i}`, expectedVersion: version }),
      ),
    );

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });

  it('refuses a versioned write to a file that is gone', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    const created = await api.write({ path: 'a.txt', content: 'one' }).expect(200);
    await api.remove('a.txt').expect(204);

    await api
      .write({ path: 'a.txt', content: 'two', expectedVersion: created.body.entry.version })
      .expect(409);
  });

  it('a write without a version overwrites, which is what a first save does', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'a.txt', content: 'one' }).expect(200);
    await api.write({ path: 'a.txt', content: 'two' }).expect(200);
    expect((await api.read('a.txt')).body.content).toBe('two');
  });
});

describe.skipIf(!db)('limits', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('refuses a file over the size limit', async () => {
    const { app, projectId, cookie } = await workspace({ FILE_MAX_BYTES: '1024' });
    const api = files(app, projectId, cookie);

    const res = await api.write({ path: 'big.txt', content: 'a'.repeat(2000) }).expect(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(await db!.projectFile.count()).toBe(0);
  });

  it('refuses a write that would exceed the project total', async () => {
    const { app, projectId, cookie } = await workspace({
      FILE_MAX_BYTES: '2048',
      PROJECT_MAX_BYTES: '2048',
    });
    const api = files(app, projectId, cookie);

    await api.write({ path: 'a.txt', content: 'a'.repeat(1500) }).expect(200);
    await api.write({ path: 'b.txt', content: 'b'.repeat(1000) }).expect(413);
  });

  it('counts a replacement against the total only once', async () => {
    // Otherwise saving the same file repeatedly would exhaust the quota.
    const { app, projectId, cookie } = await workspace({
      FILE_MAX_BYTES: '2048',
      PROJECT_MAX_BYTES: '2048',
    });
    const api = files(app, projectId, cookie);

    for (let i = 0; i < 5; i += 1) {
      await api.write({ path: 'a.txt', content: 'a'.repeat(1500) }).expect(200);
    }
  });

  it('refuses more entries than the project allows', async () => {
    const { app, projectId, cookie } = await workspace({ PROJECT_MAX_FILES: '2' });
    const api = files(app, projectId, cookie);

    await api.write({ path: 'a.txt', content: 'x' }).expect(200);
    await api.write({ path: 'b.txt', content: 'x' }).expect(200);

    const res = await api.write({ path: 'c.txt', content: 'x' }).expect(409);
    expect(res.body.error.details.limit).toBe(2);
  });
});

describe.skipIf(!db)('search', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('finds files by path', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'src/server.ts', content: 'nothing here' }).expect(200);
    await api.write({ path: 'src/client.ts', content: 'nothing here' }).expect(200);

    const res = await api.search('server').expect(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({ path: 'src/server.ts', match: 'path' });
  });

  it('finds files by content, reporting the line', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api
      .write({ path: 'a.ts', content: 'const x = 1\nconst needle = 2\nconst y = 3\n' })
      .expect(200);

    const res = await api.search('needle').expect(200);
    expect(res.body.results[0]).toMatchObject({
      path: 'a.ts',
      match: 'content',
      lineNumber: 2,
    });
    expect(res.body.results[0].line).toBe('const needle = 2');
  });

  it('matches case-insensitively', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'a.ts', content: 'const Needle = 2\n' }).expect(200);
    expect((await api.search('needle')).body.results).toHaveLength(1);
  });

  it('does not report the same file twice', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'needle.ts', content: 'needle inside too\n' }).expect(200);

    const res = await api.search('needle').expect(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].match).toBe('path');
  });

  it('skips binary files', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    const bytes = Buffer.concat([Buffer.from('needle'), Buffer.from([0xff, 0xfe, 0x00])]);
    await api
      .write({ path: 'blob.bin', content: bytes.toString('base64'), encoding: 'base64' })
      .expect(200);

    // Decoding a binary as text to search it is meaningless.
    const res = await api.search('needle').expect(200);
    expect(res.body.results.filter((r: { match: string }) => r.match === 'content')).toHaveLength(
      0,
    );
  });

  it('returns nothing for an empty query rather than everything', async () => {
    const { app, projectId, cookie } = await workspace();
    const api = files(app, projectId, cookie);

    await api.write({ path: 'a.ts', content: 'x' }).expect(200);
    expect((await api.search('   ')).body.results).toEqual([]);
  });
});

describe.skipIf(!db)('access', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('refuses an anonymous caller', async () => {
    const { app, projectId } = await workspace();
    await request(app).get(`/api/projects/${projectId}/files`).expect(401);
  });

  it('hides another account files behind a 404', async () => {
    const { app, projectId, cookie } = await workspace();
    await files(app, projectId, cookie).write({ path: 'secret.txt', content: 'x' }).expect(200);

    const stranger = await account(app, 'stranger');
    await request(app).get(`/api/projects/${projectId}/files`).set('Cookie', stranger).expect(404);
    await request(app)
      .get(`/api/projects/${projectId}/files/content`)
      .query({ path: 'secret.txt' })
      .set('Cookie', stranger)
      .expect(404);
  });

  it('lets a viewer read but not write', async () => {
    const { app, auth, projectId, cookie } = await workspace();
    await files(app, projectId, cookie).write({ path: 'a.txt', content: 'x' }).expect(200);

    const viewerCookie = await account(app, 'viewer');
    const viewer = await db!.user.findUnique({ where: { username: 'viewer' } });
    await auth.projects.upsertMembership(projectId, viewer!.id, 'VIEWER');

    const viewerApi = files(app, projectId, viewerCookie);
    await viewerApi.tree().expect(200);
    await viewerApi.read('a.txt').expect(200);

    // Shown a project is not the same as being able to change it.
    await viewerApi.write({ path: 'a.txt', content: 'changed' }).expect(403);
    await viewerApi.remove('a.txt').expect(403);
    await viewerApi.mkdir('newdir').expect(403);
    await viewerApi.move('a.txt', 'b.txt').expect(403);

    expect((await viewerApi.read('a.txt')).body.content).toBe('x');
  });

  it('lets an editor write', async () => {
    const { app, auth, projectId } = await workspace();

    const editorCookie = await account(app, 'editor');
    const editor = await db!.user.findUnique({ where: { username: 'editor' } });
    await auth.projects.upsertMembership(projectId, editor!.id, 'EDITOR');

    await files(app, projectId, editorCookie).write({ path: 'a.txt', content: 'x' }).expect(200);
  });

  it('keeps one project files out of another', async () => {
    const { app, cookie } = await workspace();
    const first = await project(app, cookie, 'First');
    const second = await project(app, cookie, 'Second');

    await files(app, first, cookie).write({ path: 'a.txt', content: 'first' }).expect(200);

    expect((await files(app, second, cookie).tree()).body.entries).toEqual([]);
    await files(app, second, cookie).read('a.txt').expect(404);
  });
});
