import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOCUMENT_AWARENESS, DOCUMENT_SYNC_STEP_1, DOCUMENT_UPDATE } from '@platform/shared';
import { loadEnv } from '../src/config/env.js';
import { sessionCookieSettings } from '../src/http/session-cookie.js';
import { createDocumentGateway } from '../src/ws/document-gateway.js';
import { createProjectEventsGateway } from '../src/ws/events-gateway.js';
import { createOutputGateway } from '../src/ws/output-gateway.js';
import { SocketGuard } from '../src/ws/socket-guard.js';
import { createTerminalGateway } from '../src/ws/terminal-gateway.js';
import { refuseUnroutedUpgrades } from '../src/ws/unrouted-upgrade.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import { RecordingExecutionProvider } from './setup/execution.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * Every WebSocket gateway on one server, attached the way `index.ts` attaches
 * them.
 *
 * The gateways share one upgrade event, and each must take only its own route.
 * Tested one at a time, as every other suite does, a gateway that grabs routes
 * it does not own looks perfect. The terminal gateway did exactly that — it
 * refused every events and document upgrade before their own gateways could
 * accept them — and no test noticed, because none put them together.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;
const ORIGIN = 'http://localhost:5173';

const servers: Server[] = [];
const sockets: WebSocket[] = [];

async function platform(options: { slowLoad?: boolean } = {}) {
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_PROJECT_CREATE_MAX: '100',
    CORS_ORIGINS: ORIGIN,
  } as NodeJS.ProcessEnv);
  const auth = testAuth(
    db!,
    config,
    new FakePasswordHasher(),
    silentLogger(),
    new RecordingExecutionProvider(),
  );
  const app = testApp({ config, auth });
  const server = createServer(app);

  if (options.slowLoad) {
    // A file that takes a moment to load, as the first open of one does on a
    // real database. Makes the race below deterministic instead of lucky.
    const join = auth.documents.join.bind(auth.documents);
    auth.documents.join = async (...args: Parameters<typeof join>) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return join(...args);
    };
  }

  const guard = new SocketGuard({
    maxPerUser: 1_000,
    maxAttempts: 100_000,
    attemptWindowMs: 60_000,
    log: { debug() {}, info() {}, warn() {}, error() {} } as never,
  });
  const common = {
    sessions: auth.sessions,
    authorization: auth.authorization,
    cookie: sessionCookieSettings(config),
    allowedOrigins: config.CORS_ORIGINS,
    guard,
    heartbeatMs: config.TERMINAL_HEARTBEAT_MS,
    log: silentLogger(),
  };

  // The order `index.ts` uses.
  createOutputGateway(server, { ...common, runs: auth.runs, maxPerProject: 10 });
  createProjectEventsGateway(server, { ...common, events: auth.events, maxPerProject: 25 });
  createDocumentGateway(server, {
    ...common,
    documents: auth.documents,
    maxPerProject: 50,
    messageBurst: 10_000,
    messagesPerSecond: 10_000,
  });
  createTerminalGateway(server, {
    ...common,
    terminals: auth.terminals,
    maxPerProject: 10,
    messageBurst: 10_000,
    messagesPerSecond: 10_000,
  });
  refuseUnroutedUpgrades(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as { port: number }).port;

  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'ada@example.test', username: 'ada', password: 'analytical-engine-1843' })
    .expect(201);
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  const project = await request(app)
    .post('/api/projects')
    .set('Cookie', cookie)
    .send({ name: 'Sockets' })
    .expect(201);
  const projectId = project.body.project.id as string;
  await request(app)
    .put(`/api/projects/${projectId}/files/content`)
    .set('Cookie', cookie)
    .send({ path: 'notes.txt', content: 'hello', encoding: 'utf8' })
    .expect(200);

  return { port, cookie, projectId };
}

/** Opens a socket and says what happened: opened, or the status it was refused with. */
function connect(
  port: number,
  path: string,
  cookie: string,
): Promise<{ socket?: WebSocket; status?: number | undefined }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: { cookie, origin: ORIGIN },
    });
    sockets.push(socket);
    socket.on('open', () => resolve({ socket }));
    socket.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
    socket.on('error', () => resolve({ status: -1 }));
  });
}

/** The next binary frame of a given type. */
function nextFrame(socket: WebSocket, type: number): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const onMessage = (data: Buffer, binary: boolean) => {
      if (!binary || data[0] !== type) return;
      socket.off('message', onMessage);
      resolve(new Uint8Array(data.subarray(1)));
    };
    socket.on('message', onMessage);
  });
}

const frame = (type: number, payload: Uint8Array) => {
  const out = new Uint8Array(payload.byteLength + 1);
  out[0] = type;
  out.set(payload, 1);
  return out;
};

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

afterAll(async () => {
  await db?.$disconnect();
});

describe.skipIf(!db)('every gateway on one server', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('lets the events socket through to its own gateway', async () => {
    const { port, cookie, projectId } = await platform();
    const result = await connect(port, `/ws/projects/${projectId}/events`, cookie);
    expect(result.status).toBeUndefined();
    expect(result.socket).toBeDefined();
  });

  it('lets two document sockets connect and exchange text and cursors', async () => {
    const { port, cookie, projectId } = await platform();
    const path = `/ws/projects/${projectId}/document?path=notes.txt`;

    const a = await connect(port, path, cookie);
    const b = await connect(port, path, cookie);
    expect(a.status).toBeUndefined();
    expect(b.status).toBeUndefined();

    // Both sync, so each holds the file's text.
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    for (const [socket, doc] of [
      [a.socket!, docA],
      [b.socket!, docB],
    ] as const) {
      const synced = nextFrame(socket, 1);
      socket.send(frame(DOCUMENT_SYNC_STEP_1, Y.encodeStateVector(doc)));
      Y.applyUpdate(doc, await synced);
    }
    expect(docA.getText('content').toString()).toBe('hello');

    // A types; B receives it.
    const arrived = nextFrame(b.socket!, DOCUMENT_UPDATE);
    const before = Y.encodeStateVector(docA);
    docA.getText('content').insert(5, ' world');
    a.socket!.send(frame(DOCUMENT_UPDATE, Y.encodeStateAsUpdate(docA, before)));
    Y.applyUpdate(docB, await arrived);
    expect(docB.getText('content').toString()).toBe('hello world');

    // A's cursor reaches B, stamped with A's account by the server.
    const awarenessA = new Awareness(docA);
    awarenessA.setLocalStateField('cursor', { anchor: 1, head: 1 });
    const seen = nextFrame(b.socket!, DOCUMENT_AWARENESS);
    a.socket!.send(frame(DOCUMENT_AWARENESS, encodeAwarenessUpdate(awarenessA, [docA.clientID])));
    const awarenessB = new Awareness(docB);
    const { applyAwarenessUpdate } = await import('y-protocols/awareness');
    applyAwarenessUpdate(awarenessB, await seen, 'test');
    const state = awarenessB.getStates().get(docA.clientID) as { user?: { name?: string } };
    expect(state.user?.name).toBe('ada');
  });

  it('gives the first person in the file, even if they speak before it has loaded', async () => {
    // A browser sends its half of the handshake the moment the socket opens.
    // For the first person in a file, that is while the server is still
    // loading it from the database — and a frame arriving then used to be
    // dropped, so they never received the file and everything after it was
    // held back by their CRDT as depending on text they did not have.
    const { port, cookie, projectId } = await platform({ slowLoad: true });
    const doc = new Y.Doc();
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/projects/${projectId}/document?path=notes.txt`,
      { headers: { cookie, origin: ORIGIN } },
    );
    sockets.push(socket);
    const synced = nextFrame(socket, 1);
    socket.on('open', () => socket.send(frame(DOCUMENT_SYNC_STEP_1, Y.encodeStateVector(doc))));

    Y.applyUpdate(doc, await synced);
    expect(doc.getText('content').toString()).toBe('hello');
  });

  it('still routes terminal upgrades to the terminal gateway', async () => {
    const { port, cookie, projectId } = await platform();
    const result = await connect(port, `/ws/projects/${projectId}/terminal`, cookie);
    // Nothing is running, but the refusal (if any) is the terminal gateway's,
    // never a 404 for a route nobody owns.
    expect(result.status).not.toBe(404);
  });

  it('refuses a route no gateway serves', async () => {
    const { port, cookie, projectId } = await platform();
    expect((await connect(port, `/ws/projects/${projectId}/nothing`, cookie)).status).toBe(404);
    expect((await connect(port, '/ws/elsewhere', cookie)).status).toBe(404);
  });
});
