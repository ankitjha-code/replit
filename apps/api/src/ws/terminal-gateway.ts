import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  clientMessageSchema,
  DEFAULT_TERMINAL_SIZE,
  projectIdFromTerminalPath,
  sessionIdFromTerminalUrl,
  type TerminalClientMessage,
  type TerminalErrorCode,
  type TerminalServerMessage,
  type TerminalSize,
} from '@platform/shared';
import { AppError } from '../errors/app-error.js';
import type { Logger } from 'pino';
import {
  TOO_MANY_TERMINALS,
  type AttachedSession,
  type TerminalSessionService,
} from '../modules/runtimes/terminal-session.service.js';
import { MessageBudget } from './socket-guard.js';
import { authorizeTerminalUpgrade, type UpgradeGuardDependencies } from './upgrade-guard.js';

export interface TerminalGatewayOptions extends UpgradeGuardDependencies {
  terminals: TerminalSessionService;
  log: Logger;
  maxPerProject: number;
  heartbeatMs: number;
  messageBurst: number;
  messagesPerSecond: number;
}

export interface TerminalGateway {
  readonly openCount: number;
  disconnectUser(projectId: string, userId: string): void;
  close(): Promise<void>;
}

const MAX_PENDING_INPUT = 64 * 1024;

export function createTerminalGateway(
  server: Server,
  options: TerminalGatewayOptions,
): TerminalGateway {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  const perProject = new Map<string, number>();
  const alive = new WeakMap<WebSocket, boolean>();

  const holders = new Map<WebSocket, { projectId: string; userId: string }>();

  const onUpgrade = (req: Parameters<typeof handleUpgrade>[0], socket: Duplex, head: Buffer) => {
    void handleUpgrade(req, socket, head);
  };

  async function handleUpgrade(
    req: { url?: string | undefined; headers: Record<string, string | string[] | undefined> },
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const pathname = pathOf(req.url);
    if (!pathname || !projectIdFromTerminalPath(pathname)) return;

    let decision;
    try {
      decision = await authorizeTerminalUpgrade(options, {
        url: req.url,
        headers: {
          origin: single(req.headers.origin),
          cookie: single(req.headers.cookie),
        },
        address: addressOf(socket),
      });
    } catch (error) {
      options.log.error({ err: error }, 'terminal upgrade check failed');
      refuse(socket, 500, 'Internal Server Error');
      return;
    }

    if (!decision.ok) {
      refuse(socket, decision.status, decision.message);
      return;
    }

    const { projectId, userId } = decision;

    if ((perProject.get(projectId) ?? 0) >= options.maxPerProject) {
      refuse(socket, 429, 'Too many terminals');
      return;
    }

    perProject.set(projectId, (perProject.get(projectId) ?? 0) + 1);

    const sessionId = sessionIdFromTerminalUrl(req.url);

    wss.handleUpgrade(req as never, socket, head, (ws) => {
      holders.set(ws, { projectId, userId });

      ws.on('close', () => {
        holders.delete(ws);
        decision.release();
      });

      void attach(ws, projectId, userId, sessionId);
    });
  }

  async function attach(
    ws: WebSocket,
    projectId: string,
    userId: string,
    sessionId: string | undefined,
  ): Promise<void> {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));

    let attached: AttachedSession | undefined;
    let released = false;
    let displaced = false;

    let pendingInput = '';
    let pendingSize: TerminalSize | undefined;

    const deliver = (message: TerminalClientMessage): void => {
      if (message.type === 'resize') {
        if (!attached) {
          pendingSize = message.size;
          return;
        }
        void attached.resize(message.size).catch((error: unknown) => {
          options.log.warn({ err: error, projectId }, 'terminal resize failed');
        });
        return;
      }

      if (!attached) {
        pendingInput = (pendingInput + message.data).slice(-MAX_PENDING_INPUT);
        return;
      }
      attached.write(message.data);
    };

    const budget = new MessageBudget(options.messageBurst, options.messagesPerSecond);

    ws.on('message', (raw) => {
      if (!budget.take()) return;

      const parsed = clientMessageSchema.safeParse(safeJson(raw.toString()));
      if (!parsed.success) {
        options.log.warn({ projectId }, 'malformed terminal message');
        return;
      }
      deliver(parsed.data);
    });

    const release = () => {
      if (released) return;
      released = true;
      const count = (perProject.get(projectId) ?? 1) - 1;
      if (count <= 0) perProject.delete(projectId);
      else perProject.set(projectId, count);
      if (!displaced) attached?.detach();
    };

    ws.on('close', release);
    ws.on('error', release);

    try {
      attached = await options.terminals.attach(
        projectId,
        userId,
        {
          onOutput: (text) => send(ws, { type: 'output', data: text }),
          onExit: (code) => {
            sendThenClose(ws, { type: 'exit', code });
          },
          onTakenOver: () => {
            displaced = true;
            sendThenClose(ws, {
              type: 'error',
              code: 'SESSION_TAKEN_OVER',
              message: 'This terminal was opened somewhere else, so this view was disconnected.',
            });
          },
        },
        { sessionId, size: DEFAULT_TERMINAL_SIZE },
      );
    } catch (error) {
      sendThenClose(ws, {
        type: 'error',
        code: codeFor(error),
        message:
          error instanceof AppError && error.expose
            ? error.message
            : 'A terminal could not be opened.',
      });
      options.log.warn({ err: error, projectId, userId }, 'terminal could not be opened');
      release();
      return;
    }

    if (ws.readyState !== ws.OPEN) {
      release();
      return;
    }

    send(ws, {
      type: 'ready',
      sessionId: attached.id,
      resumed: attached.resumed,
      truncated: attached.truncated,
    });

    if (attached.replay.length > 0) {
      send(ws, { type: 'output', data: attached.replay });
    }

    if (pendingSize) deliver({ type: 'resize', size: pendingSize });
    if (pendingInput.length > 0) {
      const held = pendingInput;
      pendingInput = '';
      deliver({ type: 'input', data: held });
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
      server.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function send(ws: WebSocket, message: TerminalServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function sendThenClose(ws: WebSocket, message: TerminalServerMessage): void {
  if (ws.readyState !== ws.OPEN) {
    ws.close();
    return;
  }

  ws.send(JSON.stringify(message), () => ws.close());
}

function refuse(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function codeFor(error: unknown): TerminalErrorCode {
  if (error instanceof AppError) {
    if (reasonOf(error) === TOO_MANY_TERMINALS) return 'TOO_MANY_TERMINALS';
    if (error.code === 'PRECONDITION_FAILED') return 'RUNTIME_NOT_RUNNING';
    if (error.code === 'RUNTIME_UNAVAILABLE') return 'RUNTIME_UNAVAILABLE';
    if (error.code === 'FORBIDDEN') return 'FORBIDDEN';
    if (error.code === 'NOT_FOUND') return 'SESSION_NOT_FOUND';
  }
  return 'EXECUTION_FAILED';
}

function reasonOf(error: AppError): string | undefined {
  const details = error.details;
  if (typeof details !== 'object' || details === null) return undefined;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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
