import { SocketGuard } from '../src/ws/socket-guard.js';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { WebSocket } from 'ws';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { terminalPath, type TerminalServerMessage } from '@platform/shared';
import { loadEnv } from '../src/config/env.js';
import { sessionCookieSettings } from '../src/http/session-cookie.js';
import { refuseUnroutedUpgrades } from '../src/ws/unrouted-upgrade.js';
import { createTerminalGateway, type TerminalGateway } from '../src/ws/terminal-gateway.js';
import type { TerminalSessionService } from '../src/modules/runtimes/terminal-session.service.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import { RecordingExecutionProvider } from './setup/execution.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * The terminal socket, over a real HTTP server and the real database.
 *
 * The execution provider is a recording double: what is under test here is who
 * may open a terminal and how the socket behaves, not what a shell does. The
 * shell itself is covered against real Docker in its own suite.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

const ORIGIN = 'http://localhost:5173';

interface Harness {
  server: Server;
  gateway: TerminalGateway;
  /** The shells themselves, which now outlive the sockets showing them. */
  terminals: TerminalSessionService;
  port: number;
  provider: RecordingExecutionProvider;
  app: ReturnType<typeof testApp>;
}

const harnesses: Harness[] = [];

async function start(overrides: Record<string, string> = {}): Promise<Harness> {
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_PROJECT_CREATE_MAX: '100',
    RATE_LIMIT_RUNTIME_CONTROL_MAX: '100',
    CORS_ORIGINS: ORIGIN,
    ...overrides,
  } as NodeJS.ProcessEnv);

  const provider = new RecordingExecutionProvider();
  const auth = testAuth(db!, config, new FakePasswordHasher(), silentLogger(), provider);
  const app = testApp({ config, auth });
  const server = createServer(app);

  // The same service the HTTP app is using. Two would disagree about which
  // shells exist, and the socket and the route are meant to be two views of
  // one set of them.
  const terminals = auth.terminals;

  const gateway = createTerminalGateway(server, {
    terminals,
    sessions: auth.sessions,
    authorization: auth.authorization,
    cookie: sessionCookieSettings(config),
    guard: socketGuard(),
    messageBurst: 10_000,
    messagesPerSecond: 10_000,
    allowedOrigins: config.CORS_ORIGINS,
    maxPerProject: config.MAX_TERMINALS_PER_PROJECT,
    heartbeatMs: config.TERMINAL_HEARTBEAT_MS,
    log: silentLogger(),
  });

  // As the server does: whatever no gateway serves is refused once, here.
  refuseUnroutedUpgrades(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const harness = { server, gateway, terminals, port, provider, app };
  harnesses.push(harness);
  return harness;
}

async function account(app: Harness['app'], name: string): Promise<string> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: `${name}@example.test`, username: name, password: 'analytical-engine-1843' })
    .expect(201);

  const header = res.headers['set-cookie'] as unknown as string[];
  return header.find((c) => c.startsWith('platform_session='))!.split(';')[0]!;
}

async function project(app: Harness['app'], cookie: string): Promise<string> {
  const res = await request(app)
    .post('/api/projects')
    .set('Cookie', cookie)
    .send({ name: 'Terminal' })
    .expect(201);
  return res.body.project.id as string;
}

/** A signed-in owner whose project is running. */
async function runningProject(overrides: Record<string, string> = {}) {
  const harness = await start(overrides);
  const cookie = await account(harness.app, 'ada');
  const projectId = await project(harness.app, cookie);

  await request(harness.app)
    .put(`/api/projects/${projectId}/files/content`)
    .set('Cookie', cookie)
    .send({ path: 'package.json', content: '{}', encoding: 'utf8' })
    .expect(200);

  await request(harness.app)
    .post(`/api/projects/${projectId}/runtime/start`)
    .set('Cookie', cookie)
    .send({})
    .expect(200);

  return { ...harness, cookie, projectId };
}

interface Connection {
  socket: WebSocket;
  /** Every message the server sent, in order. */
  messages: TerminalServerMessage[];
  /** Resolves once a message of this type arrives. */
  waitFor: (type: TerminalServerMessage['type']) => Promise<TerminalServerMessage>;
  closed: Promise<number>;
}

function connect(
  harness: Pick<Harness, 'port'>,
  projectId: string,
  options: {
    cookie?: string;
    origin?: string | null;
    path?: string;
    /** Ask to resume this shell rather than open a new one. */
    sessionId?: string;
  } = {},
): Connection {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.origin !== null) headers.Origin = options.origin ?? ORIGIN;

  const socket = new WebSocket(
    `ws://127.0.0.1:${harness.port}${options.path ?? terminalPath(projectId, options.sessionId)}`,
    { headers },
  );

  const messages: TerminalServerMessage[] = [];
  const waiters: { type: string; resolve: (m: TerminalServerMessage) => void }[] = [];

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as TerminalServerMessage;
    messages.push(message);
    for (const waiter of waiters.filter((w) => w.type === message.type)) waiter.resolve(message);
  });

  return {
    socket,
    messages,
    waitFor: (type) =>
      new Promise((resolve, reject) => {
        const existing = messages.find((m) => m.type === type);
        if (existing) {
          resolve(existing);
          return;
        }
        waiters.push({ type, resolve });
        socket.on('close', () => reject(new Error(`socket closed before ${type}`)));
        socket.on('error', reject);
      }),
    closed: new Promise<number>((resolve) => socket.on('close', (code) => resolve(code))),
  };
}

/** The HTTP status a refused handshake came back with. */
function refusalStatus(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    socket.on('open', () => reject(new Error('the handshake was accepted')));
    socket.on('error', () => undefined);
  });
}

describe.skipIf(!db)('the terminal socket', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  afterEach(async () => {
    while (harnesses.length > 0) {
      const harness = harnesses.pop()!;
      await harness.gateway.close();
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    }
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  describe('who may open one', () => {
    it('refuses a caller with no session', async () => {
      const { port, projectId } = await runningProject();
      const { socket } = connect({ port }, projectId);

      expect(await refusalStatus(socket)).toBe(401);
    });

    it('refuses a socket opened from another site', async () => {
      // The attack: a page the person is visiting opens this socket, the
      // browser attaches their cookie, and the page has a shell in their
      // project.
      const { port, projectId, cookie } = await runningProject();
      const { socket } = connect({ port }, projectId, {
        cookie,
        origin: 'https://evil.example',
      });

      expect(await refusalStatus(socket)).toBe(403);
    });

    it('refuses a socket with no origin at all', async () => {
      const { port, projectId, cookie } = await runningProject();
      const { socket } = connect({ port }, projectId, { cookie, origin: null });

      expect(await refusalStatus(socket)).toBe(403);
    });

    it('hides another account project behind a not found', async () => {
      const harness = await runningProject();
      const intruder = await account(harness.app, 'mallory');
      const { socket } = connect(harness, harness.projectId, { cookie: intruder });

      expect(await refusalStatus(socket)).toBe(404);
    });

    it('refuses a viewer, who may watch but not type', async () => {
      const harness = await runningProject();
      const viewerCookie = await account(harness.app, 'viewer');
      const viewer = await db!.user.findUniqueOrThrow({ where: { username: 'viewer' } });
      await db!.projectMember.create({
        data: { projectId: harness.projectId, userId: viewer.id, role: 'VIEWER' },
      });

      const { socket } = connect(harness, harness.projectId, { cookie: viewerCookie });
      expect(await refusalStatus(socket)).toBe(403);
    });

    it('refuses a path that is not a terminal', async () => {
      const harness = await runningProject();
      const { socket } = connect(harness, harness.projectId, {
        cookie: harness.cookie,
        path: '/ws/anything',
      });

      expect(await refusalStatus(socket)).toBe(404);
    });
  });

  describe('when the project is not running', () => {
    it('says to start it, rather than opening onto nothing', async () => {
      const harness = await start();
      const cookie = await account(harness.app, 'ada');
      const projectId = await project(harness.app, cookie);

      const connection = connect(harness, projectId, { cookie });
      const message = await connection.waitFor('error');

      expect(message).toEqual({
        type: 'error',
        code: 'RUNTIME_NOT_RUNNING',
        message: 'Start the project before opening a terminal.',
      });
      await connection.closed;
    });

    it('opens no shell for it', async () => {
      const harness = await start();
      const cookie = await account(harness.app, 'ada');
      const projectId = await project(harness.app, cookie);

      const connection = connect(harness, projectId, { cookie });
      await connection.waitFor('error');

      expect(harness.provider.terminals).toHaveLength(0);
    });
  });

  describe('a live terminal', () => {
    it('says when the shell is attached', async () => {
      const harness = await runningProject();
      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });

      await connection.waitFor('ready');
      expect(harness.provider.terminals).toHaveLength(1);
      connection.socket.close();
    });

    it('opens the shell in the running workload, not somewhere else', async () => {
      const harness = await runningProject();
      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      await connection.waitFor('ready');

      expect(harness.provider.terminals[0]?.externalId).toBe('workload-1');
      connection.socket.close();
    });

    it('delivers keystrokes to the shell', async () => {
      const harness = await runningProject();
      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      await connection.waitFor('ready');

      connection.socket.send(JSON.stringify({ type: 'input', data: 'echo hi\r' }));
      await connection.waitFor('output');

      expect(harness.provider.terminals[0]?.written).toContain('echo hi\r');
      connection.socket.close();
    });

    it('carries output back', async () => {
      const harness = await runningProject();
      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      await connection.waitFor('ready');

      harness.provider.terminals[0]?.emit('hello\r\n');
      const message = await connection.waitFor('output');

      expect(message).toEqual({ type: 'output', data: 'hello\r\n' });
      connection.socket.close();
    });

    it('passes a resize to the pseudo-terminal', async () => {
      const harness = await runningProject();
      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      await connection.waitFor('ready');

      connection.socket.send(JSON.stringify({ type: 'resize', size: { columns: 120, rows: 40 } }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(harness.provider.terminals[0]?.sizes).toContainEqual({ columns: 120, rows: 40 });
      connection.socket.close();
    });

    it('reports the shell ending, and closes', async () => {
      const harness = await runningProject();
      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      await connection.waitFor('ready');

      harness.provider.terminals[0]?.end(0);

      expect(await connection.waitFor('exit')).toEqual({ type: 'exit', code: 0 });
      await connection.closed;
    });

    it('leaves the shell running when the socket goes', async () => {
      /*
       * The point of the whole task.
       *
       * A reload used to kill whatever was running in the terminal, which is
       * the wrong trade: a build or a watch process is exactly what someone
       * has open when they reload. The socket is now a view of a shell, not
       * the shell.
       */
      const harness = await runningProject();
      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      await connection.waitFor('ready');

      connection.socket.close();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(harness.provider.terminals[0]?.closed).toBe(false);
      expect(harness.terminals.openCount).toBe(1);
    });

    it('comes back to the same shell, with what it printed while nobody watched', async () => {
      const harness = await runningProject();
      const first = connect(harness, harness.projectId, { cookie: harness.cookie });
      const opened = await first.waitFor('ready');
      const sessionId = (opened as { sessionId: string }).sessionId;

      first.socket.close();
      await first.closed;

      // The shell keeps working with nobody attached, which is the part that
      // would be worthless if the output were thrown away.
      harness.provider.terminals[0]?.emit('built in 3.2s\n');
      await new Promise((resolve) => setTimeout(resolve, 20));

      const second = connect(harness, harness.projectId, {
        cookie: harness.cookie,
        sessionId,
      });
      const resumed = await second.waitFor('ready');

      expect(resumed).toMatchObject({ sessionId, resumed: true, truncated: false });
      expect(await second.waitFor('output')).toEqual({
        type: 'output',
        data: 'built in 3.2s\n',
      });
      // The same shell, not a second one.
      expect(harness.provider.terminals).toHaveLength(1);

      second.socket.close();
    });

    it('refuses to resume a shell that is gone, rather than quietly opening a new one', async () => {
      // Being handed a fresh prompt looks identical to having lost the work,
      // which is the one outcome this must not produce silently.
      const harness = await runningProject();
      const connection = connect(harness, harness.projectId, {
        cookie: harness.cookie,
        sessionId: 'a-session-that-never-existed',
      });

      expect(await connection.waitFor('error')).toMatchObject({ code: 'SESSION_NOT_FOUND' });
      expect(harness.provider.terminals).toHaveLength(0);
    });

    it('hands the shell to the newer socket and tells the older one why', async () => {
      const harness = await runningProject();
      const first = connect(harness, harness.projectId, { cookie: harness.cookie });
      const opened = await first.waitFor('ready');
      const sessionId = (opened as { sessionId: string }).sessionId;

      // Deliberately without closing the first: this is the reload where the
      // old socket has not been reaped yet, which is the common case rather
      // than the exotic one.
      const second = connect(harness, harness.projectId, {
        cookie: harness.cookie,
        sessionId,
      });
      await second.waitFor('ready');

      expect(await first.waitFor('error')).toMatchObject({ code: 'SESSION_TAKEN_OVER' });
      // The newer socket kept the shell rather than both losing it.
      expect(harness.provider.terminals[0]?.closed).toBe(false);
      second.socket.close();
    });

    it('closes a shell nobody came back to', async () => {
      const harness = await runningProject({ TERMINAL_SESSION_IDLE_MS: '10000' });
      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      await connection.waitFor('ready');
      connection.socket.close();
      await connection.closed;
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Swept with a clock the test controls, rather than by waiting out a
      // real interval.
      await harness.terminals.reapIdle(new Date(Date.now() + 11_000));

      expect(harness.provider.terminals[0]?.closed).toBe(true);
      expect(harness.terminals.openCount).toBe(0);
    });

    it('closes the shells in a runtime when the runtime is stopped', async () => {
      const harness = await runningProject();
      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      await connection.waitFor('ready');
      connection.socket.close();
      await connection.closed;

      await request(harness.app)
        .post(`/api/projects/${harness.projectId}/runtime/stop`)
        .set('Cookie', harness.cookie)
        .send({})
        .expect(200);

      expect(harness.provider.terminals[0]?.closed).toBe(true);
      expect(harness.terminals.openCount).toBe(0);
    });
  });

  describe('what a client may send', () => {
    it('ignores a message it cannot understand', async () => {
      const harness = await runningProject();
      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      await connection.waitFor('ready');

      connection.socket.send('not json at all');
      connection.socket.send(JSON.stringify({ type: 'exec', command: 'rm -rf /' }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Dropped, not answered, and nothing reached the shell.
      expect(harness.provider.terminals[0]?.written).toEqual([]);
      expect(connection.socket.readyState).toBe(connection.socket.OPEN);
      connection.socket.close();
    });

    it('ignores input too large to be a paste', async () => {
      const harness = await runningProject();
      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      await connection.waitFor('ready');

      connection.socket.send(JSON.stringify({ type: 'input', data: 'x'.repeat(70_000) }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(harness.provider.terminals[0]?.written).toEqual([]);
      connection.socket.close();
    });
  });

  describe('limits', () => {
    it('bounds how many terminals one project may hold open', async () => {
      // Set low so the limit is reached quickly. Each terminal is a shell in
      // the container and a socket held open here.
      const harness = await runningProject({ MAX_TERMINALS_PER_PROJECT: '2' });
      const open: Connection[] = [];

      for (let i = 0; i < 2; i += 1) {
        const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
        await connection.waitFor('ready');
        open.push(connection);
      }

      const refused = connect(harness, harness.projectId, { cookie: harness.cookie });
      expect(await refusalStatus(refused.socket)).toBe(429);

      for (const connection of open) connection.socket.close();
    });

    it('counts shells rather than sockets, so reloading cannot mint new ones', async () => {
      /*
       * The limit used to count sockets, which was the same number only
       * because the two were the same thing. Now that a shell outlives its
       * socket, counting sockets would let one person open a shell, reload,
       * and repeat, holding an unbounded number of processes while never
       * having more than one window.
       */
      const harness = await runningProject({ MAX_TERMINALS_PER_PROJECT: '1' });

      const first = connect(harness, harness.projectId, { cookie: harness.cookie });
      await first.waitFor('ready');
      first.socket.close();
      await first.closed;
      await new Promise((resolve) => setTimeout(resolve, 50));

      const second = connect(harness, harness.projectId, { cookie: harness.cookie });
      expect(await second.waitFor('error')).toMatchObject({ code: 'TOO_MANY_TERMINALS' });
      expect(harness.provider.terminals).toHaveLength(1);
    });

    it('gives the place back when the shell itself ends', async () => {
      const harness = await runningProject({ MAX_TERMINALS_PER_PROJECT: '1' });

      const first = connect(harness, harness.projectId, { cookie: harness.cookie });
      await first.waitFor('ready');
      harness.provider.terminals[0]?.end(0);
      await first.closed;
      await new Promise((resolve) => setTimeout(resolve, 50));

      const second = connect(harness, harness.projectId, { cookie: harness.cookie });
      await expect(second.waitFor('ready')).resolves.toBeDefined();
      second.socket.close();
    });
  });

  describe('the list of open shells', () => {
    it('is empty before anyone opens one', async () => {
      const harness = await runningProject();
      const res = await request(harness.app)
        .get(`/api/projects/${harness.projectId}/runtime/terminals`)
        .set('Cookie', harness.cookie)
        .expect(200);

      expect(res.body).toEqual({ sessions: [] });
    });

    it('is how a page that reloaded finds the shell it had', async () => {
      const harness = await runningProject();
      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      const opened = await connection.waitFor('ready');
      connection.socket.close();
      await connection.closed;

      const res = await request(harness.app)
        .get(`/api/projects/${harness.projectId}/runtime/terminals`)
        .set('Cookie', harness.cookie)
        .expect(200);

      expect(res.body.sessions).toHaveLength(1);
      expect(res.body.sessions[0]).toMatchObject({
        id: (opened as { sessionId: string }).sessionId,
        attached: false,
      });
    });

    it('shows a shell as attached while a socket is on it', async () => {
      const harness = await runningProject();
      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      await connection.waitFor('ready');

      const res = await request(harness.app)
        .get(`/api/projects/${harness.projectId}/runtime/terminals`)
        .set('Cookie', harness.cookie)
        .expect(200);

      expect(res.body.sessions[0]).toMatchObject({ attached: true });
      connection.socket.close();
    });

    it('never shows another account shells', async () => {
      const harness = await runningProject();
      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      await connection.waitFor('ready');

      // A different account entirely, which cannot see the project at all.
      const other = await account(harness.app, 'grace');
      await request(harness.app)
        .get(`/api/projects/${harness.projectId}/runtime/terminals`)
        .set('Cookie', other)
        .expect(404);

      connection.socket.close();
    });

    it('is refused to an anonymous caller', async () => {
      const harness = await runningProject();
      await request(harness.app)
        .get(`/api/projects/${harness.projectId}/runtime/terminals`)
        .expect(401);
    });

    it('closes a shell on request, which is what closing a terminal means', async () => {
      const harness = await runningProject();
      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      const opened = await connection.waitFor('ready');
      const sessionId = (opened as { sessionId: string }).sessionId;

      await request(harness.app)
        .delete(`/api/projects/${harness.projectId}/runtime/terminals/${sessionId}`)
        .set('Cookie', harness.cookie)
        .expect(204);

      expect(harness.provider.terminals[0]?.closed).toBe(true);
      expect(harness.terminals.openCount).toBe(0);
    });

    it('treats closing one that is already gone as done', async () => {
      const harness = await runningProject();
      await request(harness.app)
        .delete(`/api/projects/${harness.projectId}/runtime/terminals/never-existed`)
        .set('Cookie', harness.cookie)
        .expect(204);
    });
  });

  describe('shutting down', () => {
    it('tells an open terminal the platform is going away', async () => {
      const harness = await runningProject();
      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      await connection.waitFor('ready');

      await harness.gateway.close();

      expect(await connection.closed).toBe(1001);
    });
  });
});

/**
 * A guard with limits nothing in these suites reaches.
 *
 * Fresh per gateway, so one suite's connections never count against another's:
 * a shared one is exactly the kind of coupling that makes a suite fail in an
 * order-dependent way.
 */
function socketGuard(): SocketGuard {
  return new SocketGuard({
    maxPerUser: 1_000,
    maxAttempts: 100_000,
    attemptWindowMs: 60_000,
    log: { debug() {}, info() {}, warn() {}, error() {} } as never,
  });
}
