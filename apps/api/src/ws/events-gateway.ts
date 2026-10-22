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

export interface ProjectEventsGatewayOptions extends UpgradeGuardDependencies {
  events: ProjectEventBus;
  log: Logger;
  maxPerProject: number;
  heartbeatMs: number;
}

export interface ProjectEventsGateway {
  readonly openCount: number;
  disconnectUser(projectId: string, userId: string): void;
  close(): Promise<void>;
}

interface Connection {
  ws: WebSocket;
  userId: string;
  username: string;
  displayName: string;
  since: Date;
  file: string | null;
}

interface Room {
  connections: Set<Connection>;
  unsubscribe: () => void;
}

export function createProjectEventsGateway(
  server: Server,
  options: ProjectEventsGatewayOptions,
): ProjectEventsGateway {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });

  const rooms = new Map<string, Room>();
  const alive = new WeakMap<WebSocket, boolean>();

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

    if ((rooms.get(projectId)?.connections.size ?? 0) >= options.maxPerProject) {
      refuse(socket, 429, 'Too many connections');
      return;
    }

    wss.handleUpgrade(req as never, socket, head, (ws) => {
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
        room.unsubscribe();
        rooms.delete(projectId);
        return;
      }
      announceRoster(projectId);
    };

    ws.on('close', release);
    ws.on('error', release);

    ws.on('message', (raw: unknown) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }

      const message = projectSocketClientMessageSchema.safeParse(parsed);
      if (!message.success) return;

      if (message.data.file === connection.file) return;

      connection.file = message.data.file;
      announceRoster(projectId);
    });

    send(ws, {
      type: 'hello',
      self: {
        userId: connection.userId,
        username: connection.username,
        displayName: connection.displayName,
      },
      members: rosterOf(projectId),
    });

    announceRoster(projectId);
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
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

function addressOf(socket: Duplex): string | undefined {
  return (socket as Duplex & { remoteAddress?: string }).remoteAddress;
}
