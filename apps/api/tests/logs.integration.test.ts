import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * A project's log through the real stack: searching it, tailing it, and taking
 * it away as a file. Requires `pnpm infra:up`.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

afterAll(async () => {
  await db?.$disconnect();
});

async function withLog() {
  const hasher = new FakePasswordHasher();
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_PROJECT_CREATE_MAX: '100',
  } as NodeJS.ProcessEnv);
  const auth = testAuth(db!, config, hasher, silentLogger());
  const app = testApp({ config, passwordHasher: hasher, auth });

  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'ada@example.test', username: 'ada', password: 'analytical-engine-1843' })
    .expect(201);
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  const project = await request(app)
    .post('/api/projects')
    .set('Cookie', cookie)
    .send({ name: 'Logged' })
    .expect(201);
  const projectId = project.body.project.id as string;

  const print = (chunk: string, stream: 'stdout' | 'stderr' = 'stdout') =>
    auth.logs.record({ projectId, source: 'RUN', sourceId: 'r-1', stream, chunk: `${chunk}\n` });

  const get = (query: Record<string, string>) =>
    request(app).get(`/api/projects/${projectId}/logs`).query(query).set('Cookie', cookie);

  return { app, cookie, projectId, print, get, auth };
}

describe.skipIf(!db)('the project log', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('finds lines by the text in them, ignoring case', async () => {
    const w = await withLog();
    w.print('server starting');
    w.print('Connection REFUSED by upstream', 'stderr');
    w.print('request served');

    const res = await w.get({ contains: 'refused' }).expect(200);
    expect(res.body.lines.map((line: { message: string }) => line.message)).toEqual([
      'Connection REFUSED by upstream',
    ]);
  });

  it('tails: after a cursor it returns only what is newer, oldest first', async () => {
    const w = await withLog();
    w.print('one');
    w.print('two');
    const first = await w.get({}).expect(200);
    const last = first.body.lines.at(-1).id as string;

    w.print('three');
    w.print('four');

    const tail = await w.get({ after: last }).expect(200);
    expect(tail.body.lines.map((line: { message: string }) => line.message)).toEqual([
      'three',
      'four',
    ]);
  });

  it('exports everything retained as a plain-text attachment the browser will not render', async () => {
    const w = await withLog();
    w.print('<script>alert(1)</script>');
    w.print('second line');

    const res = await request(w.app)
      .get(`/api/projects/${w.projectId}/logs/export`)
      .set('Cookie', w.cookie)
      .expect(200);

    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename=".+\.log"$/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const lines = res.text.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('<script>alert(1)</script>');
    expect(lines[1]).toContain('second line');
  });

  it('announces new output on the project event bus, once per batch', async () => {
    const w = await withLog();
    const seen: string[] = [];
    w.auth.events.subscribe(w.projectId, (event) => seen.push(event.type));

    w.print('a');
    w.print('b');
    w.print('c');
    await w.get({}).expect(200); // a read flushes what is pending

    expect(seen.filter((type) => type === 'logs.appended')).toHaveLength(1);
  });
});

describe.skipIf(!db)('a project deleted while its lines wait to be written', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('keeps every other project’s lines from the same batch', async () => {
    const { auth, projectId } = await withLog();
    const owner = await db!.project.findUniqueOrThrow({ where: { id: projectId } });
    const doomed = await db!.project.create({
      data: { slug: 'doomed', name: 'Doomed', ownerId: owner.ownerId },
    });

    // Both projects print into the same pending batch...
    auth.logs.record({
      projectId,
      source: 'RUN',
      sourceId: 'r',
      stream: 'stdout',
      chunk: 'kept line\n',
    });
    auth.logs.record({
      projectId: doomed.id,
      source: 'RUN',
      sourceId: 'r',
      stream: 'stdout',
      chunk: 'gone\n',
    });

    // ...and one of them is deleted before it is written.
    await db!.project.delete({ where: { id: doomed.id } });
    await auth.logs.flush();

    const kept = await db!.projectLogLine.findMany({ where: { projectId } });
    expect(kept.map((line) => line.message)).toEqual(['kept line']);
  });
});
