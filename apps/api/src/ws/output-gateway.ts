import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { projectIdFromOutputPath, type OutputMessage } from '@platform/shared';
import type { Logger } from 'pino';
import type { RunService } from '../modules/runtimes/run.service.js';
import { authorizeUpgrade, type UpgradeGuardDependencies } from './upgrade-guard.js';

/**
 * The application's output, streamed to whoever is watching.
 *
 * One direction only. A client that could write here would be a second way to
 * reach the running program, and the terminal already exists for that. The
 * socket is a window, and a window that opens is a door.
 *
 * Everything buffered so far is sent on connection, so someone who opens the
 * console after a crash sees what caused it rather than an empty panel.
 */

export interface OutputGatewayOptions extends UpgradeGuardDependencies {
  runs: RunService;
  log: Logger;
  /** Watchers one project may have at once. */
  maxPerProject: number;
  heartbeatMs: number;
}

export interface OutputGateway {
  readonly openCount: number;
  /** Drops one person's watchers, for when their access to a project changes. */
  disconnectUser(projectId: string, userId: string): void;
  close(): Promise<void>;
}

export function createOutputGateway(server: Server, options: OutputGatewayOptions): OutputGateway {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });

  const perProject = new Map<string, number>();
  const alive = new WeakMap<WebSocket, boolean>();
  /** Every open socket, by project, so a status change can reach them. */
  const watchers = new Map<string, Set<WebSocket>>();
  /**
   * Who is on each socket.
   *
   * Kept so that losing access to a project stops the stream of what its
   * application is printing, which is a project's output and not the watcher's.
   */
  const holders = new Map<WebSocket, { projectId: string; userId: string }>();

  const stopListening = options.runs.onRunChange(({ projectId, status, exitCode }) => {
    for (const ws of watchers.get(projectId) ?? []) {
      send(ws, { type: 'status', status, exitCode });
    }
  });

  const onUpgrade = (req: Parameters<typeof handleUpgrade>[0], socket: Duplex, head: Buffer) => {
    void handleUpgrade(req, socket, head);
  };

  async function handleUpgrade(
    req: { url?: string | undefined; headers: Record<string, string | string[] | undefined> },
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    // Not a terminal path, so the terminal's own gateway ignores it and this
    // one takes it. Both check the same things, in the same order.
    const pathname = pathOf(req.url);
    if (!pathname || !projectIdFromOutputPath(pathname)) return;

    let decision;
    try {
      decision = await authorizeUpgrade(options, {
        url: req.url,
        headers: {
          origin: single(req.headers.origin),
          cookie: single(req.headers.cookie),
        },
        address: addressOf(socket),
        // Watching output is part of being shown a project, so a viewer may.
        permission: 'runtime:read',
        projectIdFrom: projectIdFromOutputPath,
      });
    } catch (error) {
      options.log.error({ err: error }, 'output upgrade check failed');
      refuse(socket, 500, 'Internal Server Error');
      return;
    }

    if (!decision.ok) {
      refuse(socket, decision.status, decision.message);
      return;
    }

    const { projectId, userId } = decision;

    if ((perProject.get(projectId) ?? 0) >= options.maxPerProject) {
      refuse(socket, 429, 'Too many watchers');
      return;
    }

    perProject.set(projectId, (perProject.get(projectId) ?? 0) + 1);

    wss.handleUpgrade(req as never, socket, head, (ws) => {
      holders.set(ws, { projectId, userId });

      ws.on('close', () => {
        holders.delete(ws);
        // The account's socket slot, given back. Idempotent, because a socket
        // ends in more than one way.
        decision.release();
      });

      void attach(ws, projectId);
    });
  }

  async function attach(ws: WebSocket, projectId: string): Promise<void> {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));

    const group = watchers.get(projectId) ?? new Set();
    group.add(ws);
    watchers.set(projectId, group);

    /*
     * Filled in once the history has been sent.
     *
     * A box rather than a binding because the close handler below is made
     * first and has to be able to see whatever ends up here.
     */
    const subscription: { off?: () => void } = {};
    let released = false;

    const release = () => {
      if (released) return;
      released = true;
      subscription.off?.();
      group.delete(ws);
      const count = (perProject.get(projectId) ?? 1) - 1;
      if (count <= 0) perProject.delete(projectId);
      else perProject.set(projectId, count);
    };

    ws.on('close', release);
    ws.on('error', release);

    /*
     * Read-only, and silently so.
     *
     * A client sending anything is either broken or probing. Answering would
     * describe a protocol that does not exist in this direction.
     */
    ws.on('message', () => undefined);

    const runtimeId = await options.runs.runtimeIdFor(projectId);

    if (ws.readyState !== ws.OPEN) {
      release();
      return;
    }

    if (!runtimeId) {
      // Nothing has ever run here. An empty history is the honest answer.
      send(ws, { type: 'history', lines: [], truncated: false });
      return;
    }

    const { lines, truncated } = options.runs.history(runtimeId);
    send(ws, { type: 'history', lines, truncated });

    subscription.off = options.runs.onOutput(runtimeId, (line) => {
      send(ws, { type: 'output', stream: line.stream, data: line.data });
    });
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

    disconnectUser(projectId: string, userId: string) {
      for (const [ws, holder] of holders) {
        if (holder.projectId !== projectId || holder.userId !== userId) continue;
        ws.close(1008, 'Access to this project changed');
      }
    },

    close() {
      clearInterval(heartbeat);
      stopListening();
      server.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function send(ws: WebSocket, message: OutputMessage): void {
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
