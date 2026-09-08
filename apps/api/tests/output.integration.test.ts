import { SocketGuard } from '../src/ws/socket-guard.js';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { WebSocket } from 'ws';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { outputPath, type OutputMessage } from '@platform/shared';
import { loadEnv } from '../src/config/env.js';
import { sessionCookieSettings } from '../src/http/session-cookie.js';
import { createOutputGateway, type OutputGateway } from '../src/ws/output-gateway.js';
import { refuseUnroutedUpgrades } from '../src/ws/unrouted-upgrade.js';
import { createTerminalGateway, type TerminalGateway } from '../src/ws/terminal-gateway.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import { RecordingExecutionProvider } from './setup/execution.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * The application's output, over a real socket.
 *
 * Both gateways are attached, because the thing most likely to break is the
 * two of them sharing one upgrade event: each has to serve its own route and
 * leave the other's alone.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

const ORIGIN = 'http://localhost:5173';

interface Harness {
  server: Server;
  output: OutputGateway;
  terminals: TerminalGateway;
  port: number;
  provider: RecordingExecutionProvider;
  app: ReturnType<typeof testApp>;
  auth: ReturnType<typeof testAuth>;
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

  const shared = {
    sessions: auth.sessions,
    authorization: auth.authorization,
    cookie: sessionCookieSettings(config),
    guard: socketGuard(),
    messageBurst: 10_000,
    messagesPerSecond: 10_000,
    allowedOrigins: config.CORS_ORIGINS,
    heartbeatMs: config.TERMINAL_HEARTBEAT_MS,
    log: silentLogger(),
  };

  // Registered in the same order the real entrypoint uses.
  const output = createOutputGateway(server, {
    ...shared,
    runs: auth.runs,
    maxPerProject: config.MAX_OUTPUT_WATCHERS_PER_PROJECT,
  });
  const terminals = createTerminalGateway(server, {
    ...shared,
    terminals: auth.terminals,
    maxPerProject: config.MAX_TERMINALS_PER_PROJECT,
  });

  // As the server does: whatever no gateway serves is refused once, here.
  refuseUnroutedUpgrades(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const harness = { server, output, terminals, port, provider, app, auth };
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

/** A signed-in owner with a started runtime and a runnable project. */
async function workspace(overrides: Record<string, string> = {}) {
  const harness = await start(overrides);
  const cookie = await account(harness.app, 'ada');

  const created = await request(harness.app)
    .post('/api/projects')
    .set('Cookie', cookie)
    .send({ name: 'Output' })
    .expect(201);
  const projectId = created.body.project.id as string;

  await request(harness.app)
    .put(`/api/projects/${projectId}/files/content`)
    .set('Cookie', cookie)
    .send({ path: 'package.json', content: '{"scripts":{"start":"node x.js"}}', encoding: 'utf8' })
    .expect(200);

  await request(harness.app)
    .post(`/api/projects/${projectId}/runtime/start`)
    .set('Cookie', cookie)
    .send({})
    .expect(200);

  return {
    ...harness,
    cookie,
    projectId,
    run: () =>
      request(harness.app)
        .post(`/api/projects/${projectId}/runtime/run/start`)
        .set('Cookie', cookie)
        .send({}),
  };
}

interface Connection {
  socket: WebSocket;
  messages: OutputMessage[];
  waitFor: (type: OutputMessage['type']) => Promise<OutputMessage>;
  closed: Promise<number>;
}

function connect(
  harness: Pick<Harness, 'port'>,
  projectId: string,
  options: { cookie?: string; origin?: string | null; path?: string } = {},
): Connection {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.origin !== null) headers.Origin = options.origin ?? ORIGIN;

  const socket = new WebSocket(
    `ws://127.0.0.1:${harness.port}${options.path ?? outputPath(projectId)}`,
    { headers },
  );

  const messages: OutputMessage[] = [];
  const waiters: { type: string; resolve: (m: OutputMessage) => void }[] = [];

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as OutputMessage;
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

function refusalStatus(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    socket.on('open', () => reject(new Error('the handshake was accepted')));
    socket.on('error', () => undefined);
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

describe.skipIf(!db)('the output socket', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  afterEach(async () => {
    while (harnesses.length > 0) {
      const harness = harnesses.pop()!;
      await harness.output.close();
      await harness.terminals.close();
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    }
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  describe('who may watch', () => {
    it('refuses a caller with no session', async () => {
      const harness = await workspace();
      expect(await refusalStatus(connect(harness, harness.projectId).socket)).toBe(401);
    });

    it('refuses a socket opened from another site', async () => {
      const harness = await workspace();
      const { socket } = connect(harness, harness.projectId, {
        cookie: harness.cookie,
        origin: 'https://evil.example',
      });

      expect(await refusalStatus(socket)).toBe(403);
    });

    it('hides another account project behind a not found', async () => {
      const harness = await workspace();
      const intruder = await account(harness.app, 'mallory');

      expect(
        await refusalStatus(connect(harness, harness.projectId, { cookie: intruder }).socket),
      ).toBe(404);
    });

    it('lets a viewer watch, because output is part of being shown a project', async () => {
      const harness = await workspace();
      const viewerCookie = await account(harness.app, 'viewer');
      const viewer = await db!.user.findUniqueOrThrow({ where: { username: 'viewer' } });
      await db!.projectMember.create({
        data: { projectId: harness.projectId, userId: viewer.id, role: 'VIEWER' },
      });

      const connection = connect(harness, harness.projectId, { cookie: viewerCookie });
      await expect(connection.waitFor('history')).resolves.toBeDefined();
      connection.socket.close();
    });
  });

  describe('sharing the upgrade with the terminal', () => {
    it('serves its own route while the terminal gateway is attached', async () => {
      // Both listen to the same event. Each has to leave the other's route
      // alone, or one closes a socket the other is about to accept.
      const harness = await workspace();
      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });

      await expect(connection.waitFor('history')).resolves.toBeDefined();
      connection.socket.close();
    });

    it('still refuses a path neither gateway serves', async () => {
      const harness = await workspace();
      const { socket } = connect(harness, harness.projectId, {
        cookie: harness.cookie,
        path: '/ws/nonsense',
      });

      expect(await refusalStatus(socket)).toBe(404);
    });
  });

  describe('what a watcher receives', () => {
    it('gets an empty history when nothing has ever run', async () => {
      const harness = await workspace();
      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });

      const message = await connection.waitFor('history');
      expect(message).toEqual({ type: 'history', lines: [], truncated: false });
      connection.socket.close();
    });

    it('carries what the application prints', async () => {
      const harness = await workspace();
      await harness.run().expect(200);

      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      await connection.waitFor('history');

      harness.provider.process?.emit('listening on 3000\n');
      const message = await connection.waitFor('output');

      expect(message).toEqual({ type: 'output', stream: 'stdout', data: 'listening on 3000\n' });
      connection.socket.close();
    });

    it('keeps errors apart from ordinary output', async () => {
      const harness = await workspace();
      await harness.run().expect(200);

      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      await connection.waitFor('history');

      harness.provider.process?.emit('a failure\n', 'stderr');
      const message = await connection.waitFor('output');

      expect(message).toMatchObject({ stream: 'stderr' });
      connection.socket.close();
    });

    it('replays what it missed to a watcher that arrives late', async () => {
      // Someone opening the console after a crash needs what caused it.
      const harness = await workspace();
      await harness.run().expect(200);
      harness.provider.process?.emit('started\n');
      harness.provider.process?.emit('then failed\n', 'stderr');
      await settle();

      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      const history = await connection.waitFor('history');

      expect(history).toMatchObject({
        type: 'history',
        lines: [
          { stream: 'stdout', data: 'started\n' },
          { stream: 'stderr', data: 'then failed\n' },
        ],
      });
      connection.socket.close();
    });

    it('is told when the application ends', async () => {
      const harness = await workspace();
      await harness.run().expect(200);

      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      await connection.waitFor('history');

      harness.provider.process?.end(1);
      const message = await connection.waitFor('status');

      expect(message).toEqual({ type: 'status', status: 'FAILED', exitCode: 1 });
      connection.socket.close();
    });

    it('ignores anything a client sends', async () => {
      // A window that opens is a door. There is already a terminal for this.
      const harness = await workspace();
      await harness.run().expect(200);
      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      await connection.waitFor('history');

      connection.socket.send(JSON.stringify({ type: 'input', data: 'rm -rf /\n' }));
      await settle();

      expect(harness.provider.process?.ended).toBe(false);
      expect(connection.socket.readyState).toBe(connection.socket.OPEN);
      connection.socket.close();
    });
  });

  describe('limits', () => {
    it('bounds how many may watch one project', async () => {
      const harness = await workspace({ MAX_OUTPUT_WATCHERS_PER_PROJECT: '1' });
      const first = connect(harness, harness.projectId, { cookie: harness.cookie });
      await first.waitFor('history');

      const refused = connect(harness, harness.projectId, { cookie: harness.cookie });
      expect(await refusalStatus(refused.socket)).toBe(429);

      first.socket.close();
    });

    it('gives the place back when a watcher leaves', async () => {
      const harness = await workspace({ MAX_OUTPUT_WATCHERS_PER_PROJECT: '1' });
      const first = connect(harness, harness.projectId, { cookie: harness.cookie });
      await first.waitFor('history');
      first.socket.close();
      await first.closed;
      await settle();

      const second = connect(harness, harness.projectId, { cookie: harness.cookie });
      await expect(second.waitFor('history')).resolves.toBeDefined();
      second.socket.close();
    });
  });

  describe('shutting down', () => {
    it('tells a watcher the platform is going away', async () => {
      const harness = await workspace();
      const connection = connect(harness, harness.projectId, { cookie: harness.cookie });
      await connection.waitFor('history');

      await harness.output.close();

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
