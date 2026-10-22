import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { projectIdFromOutputPath, type OutputMessage } from '@platform/shared';
import type { Logger } from 'pino';
import type { RunService } from '../modules/runtimes/run.service.js';
import { authorizeUpgrade, type UpgradeGuardDependencies } from './upgrade-guard.js';

export interface OutputGatewayOptions extends UpgradeGuardDependencies {
  runs: RunService;
  log: Logger;
  maxPerProject: number;
  heartbeatMs: number;
}

export interface OutputGateway {
  readonly openCount: number;
  disconnectUser(projectId: string, userId: string): void;
  close(): Promise<void>;
}

export function createOutputGateway(server: Server, options: OutputGatewayOptions): OutputGateway {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });

  const perProject = new Map<string, number>();
  const alive = new WeakMap<WebSocket, boolean>();
  const watchers = new Map<string, Set<WebSocket>>();
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

    ws.on('message', () => undefined);

    const runtimeId = await options.runs.runtimeIdFor(projectId);

    if (ws.readyState !== ws.OPEN) {
      release();
      return;
    }

    if (!runtimeId) {
      send(ws, { type: 'history', lines: [], truncated: false });
      await sendStatus(ws, projectId);
      return;
    }

    const { lines, truncated } = options.runs.history(runtimeId);
    send(ws, { type: 'history', lines, truncated });

    subscription.off = options.runs.onOutput(runtimeId, (line) => {
      send(ws, { type: 'output', stream: line.stream, data: line.data });
    });

    await sendStatus(ws, projectId);
  }

  async function sendStatus(ws: WebSocket, projectId: string): Promise<void> {
    try {
      const state = await options.runs.describe(projectId);
      send(ws, { type: 'status', status: state.status, exitCode: state.exitCode });
    } catch (error) {
      options.log.warn({ err: error, projectId }, 'output socket could not read the run state');
    }
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

function addressOf(socket: Duplex): string | undefined {
  return (socket as Duplex & { remoteAddress?: string }).remoteAddress;
}
