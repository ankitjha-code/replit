import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { variableListResponseSchema } from '@platform/shared';
import { loadEnv } from '../src/config/env.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import { RecordingExecutionProvider } from './setup/execution.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * Project environment variables over real HTTP against the real database.
 *
 * The thing being checked throughout is the opposite of the secrets suite next
 * door: that a value **does** come back. Configuration nobody can read is
 * configuration nobody can correct, and that is the entire reason this exists
 * separately from secrets.
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
    .send({ name: 'Variables' })
    .expect(201);
  const projectId = created.body.project.id as string;

  const base = `/api/projects/${projectId}/variables`;
  const secretBase = `/api/projects/${projectId}/secrets`;

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
    setSecret: (key: string, value: string) =>
      request(built.app).put(secretBase).set('Cookie', cookie).send({ key, value }),
    start: () =>
      request(built.app)
        .post(`/api/projects/${projectId}/runtime/start`)
        .set('Cookie', cookie)
        .send({}),
    writeFile: (path: string, content: string) =>
      request(built.app)
        .put(`/api/projects/${projectId}/files/content`)
        .set('Cookie', cookie)
        .send({ path, content, encoding: 'utf8' }),
  };
}

describe.skipIf(!db)('project environment variables', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  describe('setting and reading back', () => {
    it('gives the value back, which is the whole point', async () => {
      const harness = await workspace();
      await harness.set('LOG_LEVEL', 'debug').expect(200);

      const res = await harness.list().expect(200);
      expect(res.body.variables).toEqual([
        expect.objectContaining({ key: 'LOG_LEVEL', value: 'debug' }),
      ]);
    });

    it('answers in the documented shape', async () => {
      const harness = await workspace();
      await harness.set('PORT', '8080').expect(200);

      const res = await harness.list().expect(200);
      expect(() => variableListResponseSchema.parse(res.body)).not.toThrow();
    });

    it('replaces a value rather than adding a second row for one name', async () => {
      const harness = await workspace();
      await harness.set('PORT', '8080').expect(200);
      await harness.set('PORT', '9090').expect(200);

      const res = await harness.list().expect(200);
      expect(res.body.variables).toHaveLength(1);
      expect(res.body.variables[0].value).toBe('9090');
    });

    it('accepts an empty value, which means something to most programs', async () => {
      // Distinguishing a variable set to nothing from one that is not set at
      // all is ordinary. This is the one place the rules differ from secrets,
      // where an empty value is only ever a mistake.
      const harness = await workspace();
      await harness.set('DEBUG', '').expect(200);

      const res = await harness.list().expect(200);
      expect(res.body.variables[0]).toMatchObject({ key: 'DEBUG', value: '' });
    });

    it('lists nothing for a project nobody has configured', async () => {
      const harness = await workspace();
      const res = await harness.list().expect(200);
      expect(res.body.variables).toEqual([]);
    });

    it('sorts by name, so the list does not reorder itself as it is edited', async () => {
      const harness = await workspace();
      await harness.set('ZONE', 'utc').expect(200);
      await harness.set('API_URL', 'http://localhost').expect(200);

      const res = await harness.list().expect(200);
      expect(res.body.variables.map((v: { key: string }) => v.key)).toEqual(['API_URL', 'ZONE']);
    });

    it('removes one', async () => {
      const harness = await workspace();
      await harness.set('PORT', '8080').expect(200);
      await harness.remove('PORT').expect(204);

      const res = await harness.list().expect(200);
      expect(res.body.variables).toEqual([]);
    });

    it('says so when removing one that was never there', async () => {
      const harness = await workspace();
      await harness.remove('NOTHING').expect(404);
    });
  });

  describe('names', () => {
    it('refuses one a shell could not use', async () => {
      const harness = await workspace();
      await harness.set('not-an-env-name', 'x').expect(422);
    });

    it('refuses one that changes how the runtime loads code', async () => {
      // The container is isolated either way. This is about a runtime that
      // behaves predictably rather than about protecting the platform.
      const harness = await workspace();
      await harness.set('LD_PRELOAD', '/tmp/evil.so').expect(422);
      await harness.set('PATH', '/tmp').expect(422);
    });

    it('says which rule the name broke, not merely that it was rejected', async () => {
      const harness = await workspace();
      const res = await harness.set('lower', 'x').expect(422);
      expect(res.body.error.details.fields[0]).toMatchObject({ path: 'key' });
      expect(res.body.error.details.fields[0].message).toMatch(/capital letters/i);
    });

    it('refuses a value with a null byte, which cannot survive the boundary', async () => {
      const harness = await workspace();
      await harness.set('GREETING', `a${String.fromCharCode(0)}b`).expect(422);
    });
  });

  describe('a name cannot be both a variable and a secret', () => {
    it('refuses a variable whose name is already a secret', async () => {
      const harness = await workspace();
      await harness.setSecret('DATABASE_URL', 'postgres://real').expect(200);

      const res = await harness.set('DATABASE_URL', 'postgres://fake').expect(409);
      expect(res.body.error.message).toMatch(/secret/i);
    });

    it('refuses a secret whose name is already a variable', async () => {
      // Overwriting a readable value with an unreadable one is the worst of
      // both: the old value is gone and the new one cannot be checked.
      const harness = await workspace();
      await harness.set('DATABASE_URL', 'postgres://fake').expect(200);

      const res = await harness.setSecret('DATABASE_URL', 'postgres://real').expect(409);
      expect(res.body.error.message).toMatch(/environment variable/i);
    });

    it('leaves the existing one untouched when it refuses', async () => {
      const harness = await workspace();
      await harness.set('SHARED', 'original').expect(200);
      await harness.setSecret('SHARED', 'secret-value').expect(409);

      const res = await harness.list().expect(200);
      expect(res.body.variables[0]).toMatchObject({ key: 'SHARED', value: 'original' });
    });

    it('allows the name once the other one is removed', async () => {
      const harness = await workspace();
      await harness.set('SHARED', 'original').expect(200);
      await harness.remove('SHARED').expect(204);
      await harness.setSecret('SHARED', 'secret-value').expect(200);
    });

    it('still allows updating a variable that already exists', async () => {
      // The conflict check must only run for a name that is new here,
      // otherwise editing a variable would collide with itself.
      const harness = await workspace();
      await harness.set('PORT', '8080').expect(200);
      await harness.set('PORT', '9090').expect(200);
    });
  });

  describe('what a container is started with', () => {
    it('receives the project variables', async () => {
      const harness = await workspace();
      await harness.set('LOG_LEVEL', 'debug').expect(200);
      await harness.set('PORT', '8080').expect(200);
      await harness.writeFile('package.json', '{}').expect(200);
      await harness.start().expect(200);

      expect(harness.provider.created[0]?.env).toMatchObject({
        LOG_LEVEL: 'debug',
        PORT: '8080',
      });
    });

    it('receives variables and secrets together', async () => {
      const harness = await workspace();
      await harness.set('LOG_LEVEL', 'debug').expect(200);
      await harness.setSecret('API_TOKEN', 'sk-live-abc').expect(200);
      await harness.writeFile('package.json', '{}').expect(200);
      await harness.start().expect(200);

      expect(harness.provider.created[0]?.env).toMatchObject({
        LOG_LEVEL: 'debug',
        API_TOKEN: 'sk-live-abc',
      });
    });

    it('receives nothing the platform itself is configured with', async () => {
      const harness = await workspace();
      await harness.set('LOG_LEVEL', 'debug').expect(200);
      await harness.writeFile('package.json', '{}').expect(200);
      await harness.start().expect(200);

      const env = harness.provider.created[0]?.env ?? {};
      expect(Object.keys(env)).toEqual(['LOG_LEVEL']);
      expect(env).not.toHaveProperty('DATABASE_URL');
      expect(env).not.toHaveProperty('SECRETS_ENCRYPTION_KEY');
    });
  });

  describe('saying when a change has not taken effect', () => {
    it('does not claim a restart is needed when nothing is running', async () => {
      const harness = await workspace();
      await harness.set('PORT', '8080').expect(200);

      const res = await harness.list().expect(200);
      expect(res.body.restartRequired).toBe(false);
    });

    it('says a restart is needed while the project is up', async () => {
      // A container is handed its environment when it is created, so editing a
      // variable changes the next start rather than the current one. Not
      // saying so is how someone spends an afternoon on a change that did
      // nothing.
      const harness = await workspace();
      await harness.writeFile('package.json', '{}').expect(200);
      await harness.start().expect(200);
      await harness.set('PORT', '8080').expect(200);

      const res = await harness.list().expect(200);
      expect(res.body.restartRequired).toBe(true);
    });
  });

  describe('limits', () => {
    it('refuses more than a project is allowed', async () => {
      const harness = await workspace({ MAX_VARIABLES_PER_PROJECT: '2' });
      await harness.set('ONE', '1').expect(200);
      await harness.set('TWO', '2').expect(200);
      await harness.set('THREE', '3').expect(413);
    });

    it('still allows editing an existing one at the limit', async () => {
      const harness = await workspace({ MAX_VARIABLES_PER_PROJECT: '1' });
      await harness.set('ONE', '1').expect(200);
      await harness.set('ONE', 'changed').expect(200);
    });

    it('reports the limit, so an interface need not guess it', async () => {
      const harness = await workspace({ MAX_VARIABLES_PER_PROJECT: '7' });
      const res = await harness.list().expect(200);
      expect(res.body.limit).toBe(7);
    });
  });

  describe('access', () => {
    it('refuses an anonymous caller', async () => {
      const harness = await workspace();
      await request(harness.app).get(`/api/projects/${harness.projectId}/variables`).expect(401);
    });

    it('keeps one account variables away from another', async () => {
      const harness = await workspace();
      await harness.set('PORT', '8080').expect(200);

      const other = await account(harness.app, 'grace');
      await request(harness.app)
        .get(`/api/projects/${harness.projectId}/variables`)
        .set('Cookie', other)
        .expect(404);
    });

    it('will not let one project address another project variable', async () => {
      const harness = await workspace();
      await harness.set('PORT', '8080').expect(200);

      const created = await request(harness.app)
        .post('/api/projects')
        .set('Cookie', harness.cookie)
        .send({ name: 'Other' })
        .expect(201);

      const res = await request(harness.app)
        .get(`/api/projects/${created.body.project.id}/variables`)
        .set('Cookie', harness.cookie)
        .expect(200);

      expect(res.body.variables).toEqual([]);
    });
  });
});

describe.skipIf(!db)('importing a .env file', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  const importText = (w: Awaited<ReturnType<typeof workspace>>, text: string, as: string) =>
    request(w.app)
      .post(`/api/projects/${w.projectId}/variables/import`)
      .set('Cookie', w.cookie)
      .send({ text, as });

  it('sets every line, and lists them afterwards', async () => {
    const w = await workspace();
    const res = await importText(
      w,
      'PORT=3000\nexport MODE="fast"\n# ignored\n',
      'variables',
    ).expect(200);

    expect(res.body.applied).toEqual(['PORT', 'MODE']);
    const listed = variableListResponseSchema.parse((await w.list().expect(200)).body);
    expect(listed.variables.map((v) => [v.key, v.value])).toEqual(
      expect.arrayContaining([
        ['PORT', '3000'],
        ['MODE', 'fast'],
      ]),
    );
  });

  it('sets the good lines and names each bad one, rather than refusing the lot', async () => {
    const w = await workspace();
    await w.setSecret('API_TOKEN', 'shh').expect(200);

    const res = await importText(
      w,
      ['GOOD=1', 'not a line', 'API_TOKEN=clash', 'ALSO_GOOD=2'].join('\n'),
      'variables',
    ).expect(200);

    expect(res.body.applied).toEqual(['GOOD', 'ALSO_GOOD']);
    expect(res.body.refused.map((r: { line: number }) => r.line).sort()).toEqual([2, 3]);
    // The clash is refused by the same rule a single set would hit.
    expect(
      res.body.refused.find((r: { key: string }) => r.key === 'API_TOKEN').reason,
    ).toBeTruthy();
  });

  it('can import straight into secrets, which are then never returned', async () => {
    const w = await workspace();
    const res = await importText(w, 'DATABASE_PASSWORD=hunter2', 'secrets').expect(200);
    expect(res.body.applied).toEqual(['DATABASE_PASSWORD']);

    const secrets = await request(w.app)
      .get(`/api/projects/${w.projectId}/secrets`)
      .set('Cookie', w.cookie)
      .expect(200);
    expect(JSON.stringify(secrets.body)).not.toContain('hunter2');
  });
});
