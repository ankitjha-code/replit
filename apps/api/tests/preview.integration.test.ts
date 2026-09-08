import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PREVIEW_GRANT_PATH, previewStateSchema } from '@platform/shared';
import { safeReturnPath } from '../src/preview/preview-server.js';
import { loadEnv } from '../src/config/env.js';
import { createPreviewServer, type PreviewServer } from '../src/preview/preview-server.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import { RecordingExecutionProvider } from './setup/execution.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * The preview, over real HTTP.
 *
 * The application being previewed is a plain local server rather than a
 * container: what is under test is the proxy and everything guarding it, and a
 * container adds nothing to that question. The whole path with a real
 * container is exercised in the browser suite.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

const SUFFIX = 'localhost:4100';
const CONTAINER_PORT = 3000;

interface Application {
  server: Server;
  port: number;
  /** Every request the application received. */
  received: { url: string; headers: Record<string, string | string[] | undefined> }[];
  /** Set to make the application answer with a cookie of its own. */
  setCookie?: string;
  /** Set to make the application refuse framing. */
  frameOptions?: string;
  body: string;
}

const applications: Application[] = [];
const servers: PreviewServer[] = [];

/** A stand-in for whatever a project is serving. */
async function application(): Promise<Application> {
  const state: Application = { server: null as never, port: 0, received: [], body: 'hello world' };

  state.server = createServer((req, res) => {
    state.received.push({ url: req.url ?? '', headers: req.headers });
    const headers: Record<string, string> = { 'content-type': 'text/plain' };
    if (state.setCookie) headers['set-cookie'] = state.setCookie;
    if (state.frameOptions) headers['x-frame-options'] = state.frameOptions;
    res.writeHead(200, headers);
    res.end(state.body);
  });

  await new Promise<void>((resolve) => state.server.listen(0, '127.0.0.1', resolve));
  const address = state.server.address();
  state.port = typeof address === 'object' && address ? address.port : 0;

  applications.push(state);
  return state;
}

function buildApi(provider: RecordingExecutionProvider) {
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_PROJECT_CREATE_MAX: '100',
    RATE_LIMIT_RUNTIME_CONTROL_MAX: '100',
    PREVIEW_HOST_SUFFIX: SUFFIX,
  } as NodeJS.ProcessEnv);

  const auth = testAuth(db!, config, new FakePasswordHasher(), silentLogger(), provider);
  return { config, auth, app: testApp({ config, auth }) };
}

/** The preview listener, on an ephemeral port, addressed by Host header. */
async function buildPreview(auth: ReturnType<typeof buildApi>['auth']) {
  const config = loadEnv({ PREVIEW_HOST_SUFFIX: SUFFIX } as NodeJS.ProcessEnv);

  const preview = createPreviewServer({
    previews: auth.previews,
    hostSuffix: SUFFIX,
    cookieName: config.PREVIEW_COOKIE_NAME,
    cookieSecure: false,
    sessionTtlSeconds: config.PREVIEW_SESSION_TTL_SECONDS,
    workspaceUrl: 'http://localhost:5173',
    log: silentLogger(),
  });

  servers.push(preview);
  await preview.listen(0, '127.0.0.1');
  return preview;
}

async function account(app: ReturnType<typeof buildApi>['app'], name: string): Promise<string> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: `${name}@example.test`, username: name, password: 'analytical-engine-1843' })
    .expect(201);

  const header = res.headers['set-cookie'] as unknown as string[];
  return header.find((c) => c.startsWith('platform_session='))!.split(';')[0]!;
}

async function project(
  app: ReturnType<typeof buildApi>['app'],
  cookie: string,
  name = 'Preview',
): Promise<string> {
  const res = await request(app)
    .post('/api/projects')
    .set('Cookie', cookie)
    .send({ name })
    .expect(201);
  return res.body.project.id as string;
}

/** A project that is running and serving something. */
async function servingProject() {
  const provider = new RecordingExecutionProvider();
  const api = buildApi(provider);
  const cookie = await account(api.app, 'ada');
  const projectId = await project(api.app, cookie);

  await request(api.app)
    .put(`/api/projects/${projectId}/files/content`)
    .set('Cookie', cookie)
    .send({ path: 'package.json', content: '{}', encoding: 'utf8' })
    .expect(200);
  await request(api.app)
    .post(`/api/projects/${projectId}/runtime/start`)
    .set('Cookie', cookie)
    .send({})
    .expect(200);

  const app = await application();
  provider.published = [{ containerPort: CONTAINER_PORT, host: '127.0.0.1', port: app.port }];

  const preview = await buildPreview(api.auth);
  return { ...api, provider, cookie, projectId, application: app, preview };
}

/** Asks the API for a grant address, as the workspace does. */
async function grantUrl(
  app: ReturnType<typeof buildApi>['app'],
  projectId: string,
  cookie: string,
): Promise<string> {
  const res = await request(app)
    .post(`/api/projects/${projectId}/preview/grant`)
    .set('Cookie', cookie)
    .send({})
    .expect(201);
  return res.body.url as string;
}

/** Talks to the preview listener as a browser would, by Host header. */
function previewRequest(preview: PreviewServer, projectId: string) {
  const address = preview.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const agent = request(`http://127.0.0.1:${port}`);
  const host = `${projectId}.${SUFFIX}`;
  return {
    get: (path = '/') => agent.get(path).set('Host', host),
    /** As a different project's hostname, which must not work. */
    asHost: (other: string, path = '/') => agent.get(path).set('Host', other),
  };
}

const tokenOf = (url: string) => new URL(url).searchParams.get('t')!;

/** The cookie a redemption set, ready to be sent back. */
function setCookieOf(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  const first = Array.isArray(header) ? header[0] : header;
  return String(first).split(';')[0]!;
}

describe.skipIf(!db)('previews', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  afterEach(async () => {
    while (servers.length > 0) await servers.pop()!.close();
    while (applications.length > 0) {
      const app = applications.pop()!;
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
    }
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  describe('what the workspace is told', () => {
    it('says to start the project when nothing is running', async () => {
      const provider = new RecordingExecutionProvider();
      const api = buildApi(provider);
      const cookie = await account(api.app, 'ada');
      const projectId = await project(api.app, cookie);

      const res = await request(api.app)
        .get(`/api/projects/${projectId}/preview`)
        .set('Cookie', cookie)
        .expect(200);

      const state = previewStateSchema.parse(res.body);
      expect(state.url).toBeNull();
      expect(state.reason).toContain('Start the project');
    });

    it('says nothing is listening when the project serves nothing yet', async () => {
      // Running is not the same as serving, and telling someone their preview
      // is ready when it is not wastes their time on the wrong problem. The
      // container is up and nothing has been run in it, so the reason points at
      // the step that is actually missing.
      const { app, projectId, cookie, provider } = await servingProject();
      provider.published = [];

      const res = await request(app)
        .get(`/api/projects/${projectId}/preview`)
        .set('Cookie', cookie)
        .expect(200);

      const state = previewStateSchema.parse(res.body);
      expect(state.url).toBeNull();
      expect(state.reason).toContain('has not been started');
      expect(state.candidatePorts.length).toBeGreaterThan(0);
    });

    it('gives an address once something answers on a watched port', async () => {
      const { app, projectId, cookie } = await servingProject();

      const res = await request(app)
        .get(`/api/projects/${projectId}/preview`)
        .set('Cookie', cookie)
        .expect(200);

      const state = previewStateSchema.parse(res.body);
      expect(state.port).toBe(CONTAINER_PORT);
      expect(state.url).toBe(`http://${projectId}.${SUFFIX}/`);
    });

    it('gives every project its own hostname', async () => {
      // One origin per project, so a project cannot script another.
      const { app, projectId, cookie } = await servingProject();
      const second = await project(app, cookie, 'Second');

      const first = previewStateSchema.parse(
        (await request(app).get(`/api/projects/${projectId}/preview`).set('Cookie', cookie)).body,
      );
      const other = previewStateSchema.parse(
        (await request(app).get(`/api/projects/${second}/preview`).set('Cookie', cookie)).body,
      );

      expect(first.url).not.toBe(other.url);
    });

    it('refuses a caller who is not a member', async () => {
      const { app, projectId } = await servingProject();
      const intruder = await account(app, 'mallory');

      await request(app)
        .get(`/api/projects/${projectId}/preview`)
        .set('Cookie', intruder)
        .expect(404);
      await request(app)
        .post(`/api/projects/${projectId}/preview/grant`)
        .set('Cookie', intruder)
        .expect(404);
    });

    it('refuses an anonymous caller', async () => {
      const { app, projectId } = await servingProject();
      await request(app).get(`/api/projects/${projectId}/preview`).expect(401);
    });
  });

  describe('opening a preview', () => {
    it('refuses a browser that has not been let in', async () => {
      const { preview, projectId } = await servingProject();

      const res = await previewRequest(preview, projectId).get().expect(401);
      expect(res.text).toContain('Open this project');
    });

    it('exchanges a grant for a cookie, and takes the token out of the address', async () => {
      const { app, preview, projectId, cookie } = await servingProject();
      const token = tokenOf(await grantUrl(app, projectId, cookie));

      const res = await previewRequest(preview, projectId)
        .get(`${PREVIEW_GRANT_PATH}?t=${token}`)
        .expect(302);

      expect(res.headers.location).toBe('/');
      expect(res.headers['set-cookie']?.[0]).toContain('platform_preview=');
      expect(res.headers['set-cookie']?.[0]).toContain('HttpOnly');
      // Host-only: no Domain attribute, so it reaches neither the platform nor
      // another project.
      expect(res.headers['set-cookie']?.[0]).not.toContain('Domain=');
    });

    it('serves the application once the cookie is held', async () => {
      const { app, preview, projectId, cookie } = await servingProject();
      const token = tokenOf(await grantUrl(app, projectId, cookie));

      const redirect = await previewRequest(preview, projectId).get(
        `${PREVIEW_GRANT_PATH}?t=${token}`,
      );
      const viewing = setCookieOf(redirect);

      const res = await previewRequest(preview, projectId).get('/').set('Cookie', viewing);

      expect(res.status).toBe(200);
      expect(res.text).toBe('hello world');
    });

    it('spends a grant once', async () => {
      // An address that leaks after the fact opens nothing.
      const { app, preview, projectId, cookie } = await servingProject();
      const token = tokenOf(await grantUrl(app, projectId, cookie));

      await previewRequest(preview, projectId).get(`${PREVIEW_GRANT_PATH}?t=${token}`).expect(302);
      await previewRequest(preview, projectId).get(`${PREVIEW_GRANT_PATH}?t=${token}`).expect(403);
    });

    it('refuses a token that was never issued', async () => {
      const { preview, projectId } = await servingProject();
      await previewRequest(preview, projectId)
        .get(`${PREVIEW_GRANT_PATH}?t=${'0'.repeat(43)}`)
        .expect(403);
    });

    it('refuses a grant redeemed at another project hostname', async () => {
      const { app, preview, projectId, cookie } = await servingProject();
      const other = await project(app, cookie, 'Other');
      const token = tokenOf(await grantUrl(app, projectId, cookie));

      await previewRequest(preview, other).get(`${PREVIEW_GRANT_PATH}?t=${token}`).expect(403);
    });

    it('refuses a viewing cookie presented at another project hostname', async () => {
      // The cookie is host-only so a browser would not send it, but the check
      // is what actually enforces it.
      const { app, preview, projectId, cookie } = await servingProject();
      const other = await project(app, cookie, 'Other');
      const token = tokenOf(await grantUrl(app, projectId, cookie));

      const redirect = await previewRequest(preview, projectId).get(
        `${PREVIEW_GRANT_PATH}?t=${token}`,
      );
      const viewing = setCookieOf(redirect);

      await previewRequest(preview, other).get('/').set('Cookie', viewing).expect(401);
    });

    it('refuses a hostname that is not a project', async () => {
      const { preview, projectId } = await servingProject();
      const res = await previewRequest(preview, projectId).asHost(SUFFIX).expect(404);
      expect(res.text).toContain('does not name a project');
    });
  });

  describe('what crosses the proxy', () => {
    async function viewing() {
      const context = await servingProject();
      const token = tokenOf(await grantUrl(context.app, context.projectId, context.cookie));
      const redirect = await previewRequest(context.preview, context.projectId).get(
        `${PREVIEW_GRANT_PATH}?t=${token}`,
      );
      const cookie = setCookieOf(redirect);
      return { ...context, viewingCookie: cookie };
    }

    it('never hands the platform cookies to the application', async () => {
      // The application is code the platform did not write. A session token is
      // not something to give it.
      const context = await viewing();

      await previewRequest(context.preview, context.projectId)
        .get('/')
        .set('Cookie', `${context.viewingCookie}; platform_session=super-secret`)
        .expect(200);

      const received = context.application.received.at(-1)!;
      expect(received.headers.cookie).toBeUndefined();
    });

    it('never lets the application set a cookie in the browser', async () => {
      // Without this a page could replace the viewing grant with one of its
      // own choosing.
      const context = await viewing();
      context.application.setCookie = 'platform_preview=chosen-by-the-app; Path=/';

      const res = await previewRequest(context.preview, context.projectId)
        .get('/')
        .set('Cookie', context.viewingCookie)
        .expect(200);

      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('lets the workspace frame the preview', async () => {
      // A development server refusing to be framed is not making a security
      // decision about this platform.
      const context = await viewing();
      context.application.frameOptions = 'DENY';

      const res = await previewRequest(context.preview, context.projectId)
        .get('/')
        .set('Cookie', context.viewingCookie)
        .expect(200);

      expect(res.headers['x-frame-options']).toBeUndefined();
    });

    it('passes the path and query through unchanged', async () => {
      // The application is served at the root of its own hostname, so its own
      // absolute paths work without rewriting anything.
      const context = await viewing();

      await previewRequest(context.preview, context.projectId)
        .get('/assets/app.js?v=2')
        .set('Cookie', context.viewingCookie)
        .expect(200);

      expect(context.application.received.at(-1)?.url).toBe('/assets/app.js?v=2');
    });

    it('tells the application what it is serving', async () => {
      const context = await viewing();

      await previewRequest(context.preview, context.projectId)
        .get('/')
        .set('Cookie', context.viewingCookie)
        .expect(200);

      expect(context.application.received.at(-1)?.headers.host).toBe(`localhost:${CONTAINER_PORT}`);
    });

    it('says so when the application stops answering', async () => {
      const context = await viewing();
      await new Promise<void>((resolve) => context.application.server.close(() => resolve()));

      const res = await previewRequest(context.preview, context.projectId)
        .get('/')
        .set('Cookie', context.viewingCookie);

      expect(res.status).toBe(502);
      expect(res.text).toMatch(/Nothing is listening|stopped answering/);
    });
  });
  describe('share links', () => {
    async function share(
      app: ReturnType<typeof buildApi>['app'],
      projectId: string,
      cookie: string,
      hours = 1,
    ): Promise<{ id: string; token: string }> {
      const res = await request(app)
        .post(`/api/projects/${projectId}/preview/shares`)
        .set('Cookie', cookie)
        .send({ hours, label: 'for the client' })
        .expect(201);
      const token = new URL(res.body.url as string).searchParams.get('share')!;
      expect(token).toBeTruthy();
      return { id: res.body.share.id as string, token };
    }

    it('lets somebody with no account open the preview', async () => {
      const { app, preview, projectId, cookie, application: served } = await servingProject();
      const { token } = await share(app, projectId, cookie);

      const redeemed = await previewRequest(preview, projectId)
        .get(`/some/page?x=1&share=${token}`)
        .expect(302);
      // The token is taken out of the address; the rest of it is kept.
      expect(redeemed.headers.location).toBe('/some/page?x=1');

      const viewing = setCookieOf(redeemed);
      const res = await previewRequest(preview, projectId)
        .get('/')
        .set('Cookie', viewing)
        .expect(200);
      expect(res.text).toBe('hello world');
      expect(served.received.length).toBeGreaterThan(0);
    });

    it('works more than once, unlike a grant', async () => {
      const { app, preview, projectId, cookie } = await servingProject();
      const { token } = await share(app, projectId, cookie);

      await previewRequest(preview, projectId).get(`/?share=${token}`).expect(302);
      await previewRequest(preview, projectId).get(`/?share=${token}`).expect(302);
    });

    it('lists shares without their tokens', async () => {
      const { app, projectId, cookie } = await servingProject();
      const { token } = await share(app, projectId, cookie);

      const res = await request(app)
        .get(`/api/projects/${projectId}/preview/shares`)
        .set('Cookie', cookie)
        .expect(200);
      expect(res.body.shares).toHaveLength(1);
      expect(res.body.shares[0].label).toBe('for the client');
      expect(res.body.shares[0].createdBy).toBe('ada');
      expect(JSON.stringify(res.body)).not.toContain(token);
    });

    it('ends every viewing a link handed out when it is revoked', async () => {
      const { app, preview, projectId, cookie } = await servingProject();
      const { id, token } = await share(app, projectId, cookie);

      const viewing = setCookieOf(
        await previewRequest(preview, projectId).get(`/?share=${token}`).expect(302),
      );
      await previewRequest(preview, projectId).get('/').set('Cookie', viewing).expect(200);

      await request(app)
        .delete(`/api/projects/${projectId}/preview/shares/${id}`)
        .set('Cookie', cookie)
        .expect(204);

      await previewRequest(preview, projectId).get('/').set('Cookie', viewing).expect(401);
      await previewRequest(preview, projectId).get(`/?share=${token}`).expect(403);
    });

    it('stops working once it expires', async () => {
      const { app, preview, projectId, cookie } = await servingProject();
      const { id, token } = await share(app, projectId, cookie);

      await db!.previewShare.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await previewRequest(preview, projectId).get(`/?share=${token}`).expect(403);
    });

    it('refuses a link at another project hostname', async () => {
      const { app, preview, projectId, cookie } = await servingProject();
      const other = await project(app, cookie, 'Other');
      const { token } = await share(app, projectId, cookie);

      await previewRequest(preview, other).get(`/?share=${token}`).expect(403);
    });

    it('refuses a token that was never issued', async () => {
      const { preview, projectId } = await servingProject();
      await previewRequest(preview, projectId).get('/?share=not-a-real-token').expect(403);
    });

    it('is only for people who could deploy', async () => {
      const { app, projectId, cookie } = await servingProject();
      const viewerCookie = await account(app, 'grace');
      const grace = await db!.user.findUniqueOrThrow({ where: { username: 'grace' } });
      await db!.projectMember.create({ data: { projectId, userId: grace.id, role: 'VIEWER' } });

      // A viewer can see the preview…
      await request(app)
        .get(`/api/projects/${projectId}/preview`)
        .set('Cookie', viewerCookie)
        .expect(200);
      // …but cannot hand it to strangers.
      await request(app)
        .post(`/api/projects/${projectId}/preview/shares`)
        .set('Cookie', viewerCookie)
        .send({ hours: 1 })
        .expect(403);
      await request(app)
        .get(`/api/projects/${projectId}/preview/shares`)
        .set('Cookie', viewerCookie)
        .expect(403);

      // And the owner's share is not revocable from another project's address.
      const { id } = await share(app, projectId, cookie);
      const other = await project(app, cookie, 'Other');
      await request(app)
        .delete(`/api/projects/${other}/preview/shares/${id}`)
        .set('Cookie', cookie)
        .expect(404);
    });

    it('refuses a lifetime past a week', async () => {
      const { app, projectId, cookie } = await servingProject();
      await request(app)
        .post(`/api/projects/${projectId}/preview/shares`)
        .set('Cookie', cookie)
        .send({ hours: 169 })
        .expect(422);
    });
  });

  describe('where a redemption sends the browser', () => {
    it('only ever to a path on the same host', () => {
      expect(safeReturnPath(null)).toBe('/');
      expect(safeReturnPath('/dashboard?a=1')).toBe('/dashboard?a=1');
      expect(safeReturnPath('https://evil.example')).toBe('/');
      expect(safeReturnPath('//evil.example')).toBe('/');
      expect(safeReturnPath('/\\evil.example')).toBe('/');
      expect(safeReturnPath('javascript:alert(1)')).toBe('/');
    });

    it('ignores a grant that asks to go elsewhere', async () => {
      const { app, preview, projectId, cookie } = await servingProject();
      const token = tokenOf(await grantUrl(app, projectId, cookie));

      const res = await previewRequest(preview, projectId)
        .get(`${PREVIEW_GRANT_PATH}?t=${token}&to=${encodeURIComponent('//evil.example')}`)
        .expect(302);
      expect(res.headers.location).toBe('/');
    });
  });
});
