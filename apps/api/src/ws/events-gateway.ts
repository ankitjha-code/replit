import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  projectIdFromEventsPath,
  projectSocketClientMessageSchema,
  type PresenceMember,
  type ProjectEvent,
  type ProjectSocketServerMessage,
} from '@platform/shared';
import type { Logger } from 'pino';
import type { ProjectEventBus } from '../events/project-event-bus.js';
import { authorizeProjectEventsUpgrade, type UpgradeGuardDependencies } from './upgrade-guard.js';

/**
 * What is happening in a project, and who else is looking at it.
 *
 * Two questions on one socket. They could have been two, and two would have
 * meant two authorizations, two heartbeats, and two ways for a client to be half
 * connected while believing it was fine. One socket per project per window is
 * also what the browser's connection budget wants.
 *
 * Almost read-only. A client may say which file it is looking at and nothing
 * else: there is no message on this socket that changes a project, because every
 * change goes through an HTTP route where it is authorized per request. A socket
 * is authorized once, at upgrade, and a long-lived connection that can write is
 * a permission check that happened a long time ago.
 *
 * Presence lives in this process's memory and nowhere else. After a restart the
 * roster is empty, which is correct rather than a gap: after a restart nobody is
 * connected.
 */

export interface ProjectEventsGatewayOptions extends UpgradeGuardDependencies {
  events: ProjectEventBus;
  log: Logger;
  /** Connections one project may have at once, across everybody in it. */
  maxPerProject: number;
  heartbeatMs: number;
}

export interface ProjectEventsGateway {
  readonly openCount: number;
  /** Drops one person's connections, for when their access to a project changes. */
  disconnectUser(projectId: string, userId: string): void;
  close(): Promise<void>;
}

/** One open window, and who is behind it. */
interface Connection {
  ws: WebSocket;
  userId: string;
  username: string;
  displayName: string;
  since: Date;
  /** What they last said they were looking at. Null until they say. */
  file: string | null;
}

/** Everyone in one project, and the bus subscription telling them things. */
interface Room {
  connections: Set<Connection>;
  unsubscribe: () => void;
}

export function createProjectEventsGateway(
  server: Server,
  options: ProjectEventsGatewayOptions,
): ProjectEventsGateway {
  /*
   * Small, because the only thing a client may send is which file it is in.
   *
   * A path is bounded by the shared contract, so anything approaching this
   * limit is not a path. The frame is dropped rather than parsed.
   */
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });

  const rooms = new Map<string, Room>();
  const alive = new WeakMap<WebSocket, boolean>();

  /**
   * The roster, aggregated by person.
   *
   * Somebody with two tabs open is one person in the room. A roster that counted
   * windows would say two people are here and name them both the same, which is
   * worse than useless when the question is who you are working alongside.
   *
   * The file shown is the one from their most recently arrived window, which is
   * the one they are most likely looking at. Stated here because it is a guess,
   * and a guess should be written down where it is made.
   */
  function rosterOf(projectId: string): PresenceMember[] {
    const byUser = new Map<string, PresenceMember>();

    for (const connection of rooms.get(projectId)?.connections ?? []) {
      const held = byUser.get(connection.userId);

      if (!held) {
        byUser.set(connection.userId, {
          userId: connection.userId,
          username: connection.username,
          displayName: connection.displayName,
          file: connection.file,
          since: connection.since.toISOString(),
          connections: 1,
        });
        continue;
      }

      held.connections += 1;
      // The earliest arrival, so "here since" means since they first arrived
      // rather than since they last opened another tab.
      if (connection.since.toISOString() < held.since) held.since = connection.since.toISOString();
      if (connection.file !== null) held.file = connection.file;
    }

    return [...byUser.values()].sort((a, b) =>
      a.since === b.since ? a.username.localeCompare(b.username) : a.since < b.since ? -1 : 1,
    );
  }

  function broadcast(projectId: string, message: ProjectSocketServerMessage): void {
    for (const connection of rooms.get(projectId)?.connections ?? []) {
      send(connection.ws, message);
    }
  }

  function announceRoster(projectId: string): void {
    broadcast(projectId, { type: 'presence', members: rosterOf(projectId) });
  }

  /**
   * Starts a room, and subscribes it to the bus.
   *
   * One subscription per project rather than one per socket: the bus fans out to
   * listeners, and a room that fans out to its own members turns a hundred
   * windows on one project into one listener instead of a hundred.
   */
  function roomFor(projectId: string): Room {
    const held = rooms.get(projectId);
    if (held) return held;

    const room: Room = {
      connections: new Set<Connection>(),
      unsubscribe: options.events.subscribe(projectId, (event: ProjectEvent) => {
        broadcast(projectId, { type: 'event', at: new Date().toISOString(), event });
      }),
    };

    rooms.set(projectId, room);
    return room;
  }

  const onUpgrade = (req: Parameters<typeof handleUpgrade>[0], socket: Duplex, head: Buffer) => {
    void handleUpgrade(req, socket, head);
  };

  async function handleUpgrade(
    req: { url?: string | undefined; headers: Record<string, string | string[] | undefined> },
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    // Not this gateway's path, so one of the others will take it. Every gateway
    // on this server checks its own route first and leaves the rest alone.
    const pathname = pathOf(req.url);
    if (!pathname || !projectIdFromEventsPath(pathname)) return;

    let decision;
    try {
      decision = await authorizeProjectEventsUpgrade(options, {
        url: req.url,
        headers: { origin: single(req.headers.origin), cookie: single(req.headers.cookie) },
        address: addressOf(socket),
      });
    } catch (error) {
      options.log.error({ err: error }, 'project events upgrade check failed');
      refuse(socket, 500, 'Internal Server Error');
      return;
    }

    if (!decision.ok) {
      refuse(socket, decision.status, decision.message);
      return;
    }

    const { projectId, userId, username, displayName } = decision;

    /*
     * A ceiling on one project's connections.
     *
     * Presence is broadcast to everyone on every change, so the cost of a room
     * grows with the square of the people in it. The limit is on the room rather
     * than on the person because that is what bounds the broadcast.
     */
    if ((rooms.get(projectId)?.connections.size ?? 0) >= options.maxPerProject) {
      refuse(socket, 429, 'Too many connections');
      return;
    }

    wss.handleUpgrade(req as never, socket, head, (ws) => {
      // The account's socket slot, given back when this connection ends.
      // Idempotent, because a socket ends in more than one way.
      ws.on('close', () => decision.release());
      ws.on('error', () => decision.release());

      attach(
        ws,
        {
          ws,
          userId,
          username,
          displayName: displayName ?? username,
          since: new Date(),
          file: null,
        },
        projectId,
      );
    });
  }

  function attach(ws: WebSocket, connection: Connection, projectId: string): void {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));

    const room = roomFor(projectId);
    room.connections.add(connection);

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      room.connections.delete(connection);

      if (room.connections.size === 0) {
        // Nobody left. The subscription goes with them, so a project nobody is
        // watching costs nothing at all.
        room.unsubscribe();
        rooms.delete(projectId);
        return;
      }
      announceRoster(projectId);
    };

    ws.on('close', release);
    ws.on('error', release);

    ws.on('message', (raw: unknown) => {
      /*
       * Everything from a client is parsed against the contract.
       *
       * Not because a browser would send something else, but because whatever is
       * on the other end of this socket is not necessarily a browser. A frame
       * that does not parse is dropped in silence: answering would describe a
       * protocol that does not exist.
       */
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }

      const message = projectSocketClientMessageSchema.safeParse(parsed);
      if (!message.success) return;

      // Unchanged is not news. A client repeating itself on a timer should not
      // make every other window in the project redraw.
      if (message.data.file === connection.file) return;

      connection.file = message.data.file;
      announceRoster(projectId);
    });

    // Sent first, so a client knows who the server thinks it is before it is
    // told who else is here. Without it, a client cannot leave itself out of the
    // roster it draws.
    send(ws, {
      type: 'hello',
      self: {
        userId: connection.userId,
        username: connection.username,
        displayName: connection.displayName,
      },
      members: rosterOf(projectId),
    });

    // And everybody else learns somebody arrived.
    announceRoster(projectId);
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        // Missed a round trip. Terminated rather than closed: a socket that did
        // not answer a ping will not answer a close handshake either, and a
        // stale presence entry is a person the roster says is here and is not.
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, options.heartbeatMs);
  heartbeat.unref();

  server.on('upgrade', onUpgrade);

  return {
    get openCount() {
      return wss.clients.size;
    },

    /**
     * Closes one person's connections to one project.
     *
     * Their client reconnects and is authorized again from scratch, which is
     * the only honest way to apply access decided at upgrade. Somebody who
     * still belongs is back within a second; somebody who does not is refused,
     * and stops appearing in the roster because they are no longer connected.
     */
    disconnectUser(projectId, userId) {
      for (const connection of rooms.get(projectId)?.connections ?? []) {
        if (connection.userId !== userId) continue;
        connection.ws.close(1008, 'Access to this project changed');
      }
    },

    close() {
      clearInterval(heartbeat);
      server.off('upgrade', onUpgrade);

      for (const room of rooms.values()) room.unsubscribe();
      rooms.clear();

      for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function send(ws: WebSocket, message: ProjectSocketServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function refuse(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function pathOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, 'http://placeholder.invalid').pathname;
  } catch {
    return undefined;
  }
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Where an upgrade came from.
 *
 * A `Duplex` does not promise a remote address, because not every duplex stream
 * is a socket. This one always is, and the cast is narrowing something already
 * true rather than asserting something hoped for. Unknown addresses share one
 * bucket, which is the safe direction: it makes the limit stricter for them, not
 * looser.
 */
function addressOf(socket: Duplex): string | undefined {
  return (socket as Duplex & { remoteAddress?: string }).remoteAddress;
}
