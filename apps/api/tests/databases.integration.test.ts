import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseStateResponseSchema } from '@platform/shared';
import { loadEnv } from '../src/config/env.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import { RecordingExecutionProvider } from './setup/execution.js';
import { UnavailableUserDatabaseProvider } from '../src/userdb/unavailable-provider.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * The database a project's application gets, against a real PostgreSQL server.
 *
 * Two claims are being tested, and only one of them is about features.
 *
 * The feature claim is that a project can be given a working database and its
 * application is started knowing how to reach it.
 *
 * The security claim is that the credential handed to a project reaches that
 * database and nothing else: not the platform's own database, and not another
 * project's. Those are checked by actually connecting with `pg` and watching the
 * server refuse, because a GRANT nobody exercised is a GRANT nobody has
 * verified.
 *
 * Skips with a message when the server is not running, rather than passing
 * against nothing.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

const ADMIN_URL =
  process.env.USER_DATABASE_ADMIN_URL ??
  'postgresql://userdb_admin:userdb_dev_only@127.0.0.1:5452/postgres';

/** Whether the second server is there at all. */
const serverUp = await (async () => {
  const client = new Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
})();

const KEY = randomBytes(32).toString('base64');

/** Databases this suite made, dropped at the end whatever happens. */
const made: { name: string; role: string }[] = [];

function buildApp(overrides: Record<string, string> = {}, options: { noServer?: boolean } = {}) {
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_PROJECT_CREATE_MAX: '100',
    RATE_LIMIT_RUNTIME_CONTROL_MAX: '100',
    SECRETS_ENCRYPTION_KEY: KEY,
    USER_DATABASE_ADMIN_URL: ADMIN_URL,
    ...overrides,
  } as NodeJS.ProcessEnv);

  const provider = new RecordingExecutionProvider();
  const auth = testAuth(
    db!,
    config,
    new FakePasswordHasher(),
    silentLogger(),
    provider,
    undefined,
    options.noServer ? new UnavailableUserDatabaseProvider() : undefined,
  );
  return { provider, config, app: testApp({ config, auth }) };
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

async function workspace(
  overrides: Record<string, string> = {},
  options: { noServer?: boolean } = {},
) {
  const built = buildApp(overrides, options);
  const cookie = await account(built.app, 'ada');

  const created = await request(built.app)
    .post('/api/projects')
    .set('Cookie', cookie)
    .send({ name: 'Database' })
    .expect(201);
  const projectId = created.body.project.id as string;

  const base = `/api/projects/${projectId}/database`;

  return {
    ...built,
    cookie,
    projectId,
    provision: () => request(built.app).post(base).set('Cookie', cookie).send({}),
    get: () => request(built.app).get(base).set('Cookie', cookie),
    deleteProject: () =>
      request(built.app).delete(`/api/projects/${projectId}`).set('Cookie', cookie),
    setVariable: (key: string, value: string) =>
      request(built.app)
        .put(`/api/projects/${projectId}/variables`)
        .set('Cookie', cookie)
        .send({ key, value }),
    setSecret: (key: string, value: string) =>
      request(built.app)
        .put(`/api/projects/${projectId}/secrets`)
        .set('Cookie', cookie)
        .send({ key, value }),
    writeFile: (path: string, content: string) =>
      request(built.app)
        .put(`/api/projects/${projectId}/files/content`)
        .set('Cookie', cookie)
        .send({ path, content, encoding: 'utf8' }),
    start: () =>
      request(built.app)
        .post(`/api/projects/${projectId}/runtime/start`)
        .set('Cookie', cookie)
        .send({}),
  };
}

/**
 * Connects with the credentials the platform handed out.
 *
 * Over loopback rather than the container host the URL names, because this test
 * is the control plane and not an application. Same server, different door.
 */
async function connectAs(
  connection: { username: string; password: string; database: string },
  database = connection.database,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const admin = new URL(ADMIN_URL);
  const client = new Client({
    host: admin.hostname,
    port: Number(admin.port || 5432),
    user: connection.username,
    password: connection.password,
    database,
    connectionTimeoutMillis: 4_000,
  });

  try {
    await client.connect();
    await client.query('SELECT 1');
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Removes a database this suite created, whatever state it is in. */
async function dropDirectly(spec: { name: string; role: string }): Promise<void> {
  const client = new Client({ connectionString: ADMIN_URL });
  try {
    await client.connect();
    await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [spec.name],
    );
    await client.query(`DROP DATABASE IF EXISTS "${spec.name}"`);
    await client.query(`DROP ROLE IF EXISTS "${spec.role}"`);
  } catch {
    // The suite is finishing; a failure here is not a test result.
  } finally {
    await client.end().catch(() => undefined);
  }
}

describe.skipIf(!db || !serverUp)('the database a project gets', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  afterAll(async () => {
    for (const spec of made) await dropDirectly(spec);
    await db?.$disconnect();
  });

  /** Provisions, and remembers what to clean up. */
  async function provisioned(harness: Awaited<ReturnType<typeof workspace>>) {
    const res = await harness.provision().expect(201);
    const row = await db!.projectDatabase.findUnique({ where: { projectId: harness.projectId } });
    if (row) made.push({ name: row.name, role: row.role });
    return { body: res.body, row: row! };
  }

  describe('provisioning', () => {
    it('reports it ready, with somewhere to connect', async () => {
      const harness = await workspace();
      const { body } = await provisioned(harness);

      expect(body.database.status).toBe('READY');
      expect(body.database.connection.database).toMatch(/^p_[0-9a-f]{32}$/);
      expect(body.database.connection.username).toMatch(/^r_[0-9a-f]{32}$/);
      expect(body.database.connection.url).toContain('postgresql://');
    });

    it('answers in the documented shape', async () => {
      const harness = await workspace();
      const res = await harness.provision().expect(201);
      expect(() => databaseStateResponseSchema.parse(res.body)).not.toThrow();
    });

    it('hands out a credential that really works', async () => {
      // A GRANT nobody exercised is a GRANT nobody has verified.
      const harness = await workspace();
      const { body } = await provisioned(harness);

      expect(await connectAs(body.database.connection)).toEqual({ ok: true });
    });

    it('names the container host, not the platform loopback', async () => {
      // An application cannot reach the platform's loopback. A URL that names
      // it would be a connection string that works nowhere it is used.
      const harness = await workspace();
      const { body } = await provisioned(harness);

      expect(body.database.connection.host).toBe('platform-userdb');
      expect(body.database.connection.url).toContain('@platform-userdb:');
      expect(body.database.connection.url).not.toContain('127.0.0.1');
    });

    it('says there is none before anyone asks for one', async () => {
      const harness = await workspace();
      const res = await harness.get().expect(200);
      expect(res.body.database).toBeNull();
      expect(res.body.unavailableReason).toBeNull();
    });

    it('refuses a second one rather than replacing the first', async () => {
      // A second database would leave the first holding the only copy of data
      // nobody can reach any more.
      const harness = await workspace();
      await provisioned(harness);
      await harness.provision().expect(409);
    });

    it('stores the password encrypted, not as text', async () => {
      const harness = await workspace();
      const { body, row } = await provisioned(harness);

      const stored = Buffer.from(row.password).toString('utf8');
      expect(stored).not.toContain(body.database.connection.password);
    });
  });

  describe('what the credential cannot reach', () => {
    it('cannot open the platform database', async () => {
      /*
       * The claim the whole design rests on.
       *
       * It holds because this is a different server process, not because of a
       * permission: the platform's tables are not in this server at all. The
       * attempt is made anyway, because an architectural claim nobody tested is
       * an architectural claim.
       */
      const harness = await workspace();
      const { body } = await provisioned(harness);

      const result = await connectAs(body.database.connection, 'platform');
      expect(result.ok).toBe(false);
    });

    it('cannot open the administrator database it was created from', async () => {
      /*
       * This one failed when it was first written, which is why it is here.
       *
       * PostgreSQL grants CONNECT on the `postgres` database to PUBLIC, so a
       * new role could open it. No other project's data was reachable that way,
       * but the shared catalogues were: one project could list every other
       * project's database and role names and start guessing at them.
       */
      const harness = await workspace();
      const { body } = await provisioned(harness);

      const result = await connectAs(body.database.connection, 'postgres');
      expect(result.ok).toBe(false);
    });

    it('cannot open the template database either', async () => {
      const harness = await workspace();
      const { body } = await provisioned(harness);

      const result = await connectAs(body.database.connection, 'template1');
      expect(result.ok).toBe(false);
    });

    it('cannot open another project database', async () => {
      // Between projects the boundary is a role rather than a separate server,
      // so this one genuinely has to be arranged and genuinely has to be tested.
      const first = await workspace();
      const firstDb = await provisioned(first);

      const created = await request(first.app)
        .post('/api/projects')
        .set('Cookie', first.cookie)
        .send({ name: 'Second' })
        .expect(201);
      const secondId = created.body.project.id as string;

      const secondRes = await request(first.app)
        .post(`/api/projects/${secondId}/database`)
        .set('Cookie', first.cookie)
        .send({})
        .expect(201);
      const secondRow = await db!.projectDatabase.findUnique({ where: { projectId: secondId } });
      if (secondRow) made.push({ name: secondRow.name, role: secondRow.role });

      const crossed = await connectAs(
        firstDb.body.database.connection,
        secondRes.body.database.connection.database,
      );
      expect(crossed.ok).toBe(false);
    });
  });

  describe('what the application is started with', () => {
    it('is told how to reach its database', async () => {
      const harness = await workspace();
      const { body } = await provisioned(harness);
      await harness.writeFile('package.json', '{}').expect(200);
      await harness.start().expect(200);

      const env = harness.provider.created[0]?.env ?? {};
      expect(env.DATABASE_URL).toBe(body.database.connection.url);
      expect(env.PGHOST).toBe('platform-userdb');
      expect(env.PGDATABASE).toBe(body.database.connection.database);
      expect(env.PGUSER).toBe(body.database.connection.username);
      expect(env.PGPASSWORD).toBe(body.database.connection.password);
      expect(env.PGPORT).toBe('5432');
    });

    it('is told nothing about a database when it has none', async () => {
      const harness = await workspace();
      await harness.writeFile('package.json', '{}').expect(200);
      await harness.start().expect(200);

      const env = harness.provider.created[0]?.env ?? {};
      expect(env).not.toHaveProperty('DATABASE_URL');
      expect(env).not.toHaveProperty('PGPASSWORD');
    });

    it('is never given the administrator credentials', async () => {
      const harness = await workspace();
      await provisioned(harness);
      await harness.writeFile('package.json', '{}').expect(200);
      await harness.start().expect(200);

      const env = harness.provider.created[0]?.env ?? {};
      expect(JSON.stringify(env)).not.toContain('userdb_admin');
    });
  });

  describe('one name, one meaning', () => {
    it('refuses a variable a database already sets', async () => {
      const harness = await workspace();
      await provisioned(harness);
      const res = await harness.setVariable('DATABASE_URL', 'postgres://mine').expect(409);
      expect(res.body.error.message).toMatch(/database already sets/i);
    });

    it('refuses a secret a database already sets', async () => {
      const harness = await workspace();
      await provisioned(harness);
      await harness.setSecret('PGPASSWORD', 'hunter2').expect(409);
    });

    it('refuses to provision while a variable holds one of those names', async () => {
      const harness = await workspace();
      await harness.setVariable('DATABASE_URL', 'postgres://mine').expect(200);

      const res = await harness.provision().expect(409);
      expect(res.body.error.message).toMatch(/DATABASE_URL/);
      // Nothing was recorded for a database that was never made.
      expect(await db!.projectDatabase.count()).toBe(0);
    });

    it('leaves unrelated names alone', async () => {
      const harness = await workspace();
      await provisioned(harness);
      await harness.setVariable('LOG_LEVEL', 'debug').expect(200);
    });
  });

  describe('deleting the project', () => {
    it('drops the database with it', async () => {
      const harness = await workspace();
      const { body, row } = await provisioned(harness);
      expect(await connectAs(body.database.connection)).toEqual({ ok: true });

      await harness.deleteProject().expect(204);

      // Gone from the server, not merely from the platform's record of it.
      const after = await connectAs(body.database.connection);
      expect(after.ok).toBe(false);
      expect(await db!.projectDatabase.findUnique({ where: { id: row.id } })).toBeNull();
    });
  });

  describe('access', () => {
    it('refuses an anonymous caller', async () => {
      const harness = await workspace();
      await request(harness.app).get(`/api/projects/${harness.projectId}/database`).expect(401);
    });

    it('keeps one account away from another database', async () => {
      const harness = await workspace();
      await provisioned(harness);

      const other = await account(harness.app, 'grace');
      await request(harness.app)
        .get(`/api/projects/${harness.projectId}/database`)
        .set('Cookie', other)
        .expect(404);
    });
  });
});

describe.skipIf(!db)('an installation with no database server', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('says so rather than offering something it cannot do', async () => {
    const harness = await workspace({}, { noServer: true });
    const res = await harness.get().expect(200);

    expect(res.body.database).toBeNull();
    expect(res.body.unavailableReason).toMatch(/no database server configured/i);
  });

  it('refuses to provision, and records nothing', async () => {
    // An installation with no server must not accumulate rows describing
    // databases that will never exist.
    const harness = await workspace({}, { noServer: true });
    await harness.provision().expect(503);
    expect(await db!.projectDatabase.count()).toBe(0);
  });

  it('still lets the project be deleted', async () => {
    const harness = await workspace({}, { noServer: true });
    await harness.deleteProject().expect(204);
  });
});
