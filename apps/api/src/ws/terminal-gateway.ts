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

/**
 * The terminal WebSocket.
 *
 * One socket, one **view** of a shell. The socket no longer owns the shell:
 * closing it detaches, and the shell carries on. That is what lets a reload
 * come back to a running build instead of killing it.
 *
 * The concern the old design had was real, and it is answered somewhere else
 * rather than abandoned: a shell nobody is attached to is closed after an idle
 * period by the session service, so a process nobody will ever stop still does
 * not accumulate.
 *
 * This file is deliberately thin. It speaks the protocol and owns the socket;
 * every rule about what a session is, who may resume it and when it ends lives
 * in the session service, where it can be tested without a socket.
 */

export interface TerminalGatewayOptions extends UpgradeGuardDependencies {
  terminals: TerminalSessionService;
  log: Logger;
  /**
   * Sockets one project may have open at once.
   *
   * A cheap guard in front of the session service's own limit on shells, which
   * is the one that protects the host. This one exists so a flood of upgrades
   * is refused before any of them reaches a container runtime.
   */
  maxPerProject: number;
  /** How often a silent socket is checked for still being there. */
  heartbeatMs: number;
  /** How much one socket may send, as a burst and then a rate. */
  messageBurst: number;
  messagesPerSecond: number;
}

export interface TerminalGateway {
  /** Open sockets, for tests and for shutdown reporting. */
  readonly openCount: number;
  /** Drops one person's terminals, for when their access to a project changes. */
  disconnectUser(projectId: string, userId: string): void;
  close(): Promise<void>;
}

/**
 * How much typing is held while a shell is being opened.
 *
 * Bounded, because a socket whose shell never opens must not become a way to
 * make the server hold memory.
 */
const MAX_PENDING_INPUT = 64 * 1024;

export function createTerminalGateway(
  server: Server,
  options: TerminalGatewayOptions,
): TerminalGateway {
  // `noServer`, because the upgrade is authorized before a socket exists. The
  // library's own path matching would accept it first and ask afterwards.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  const perProject = new Map<string, number>();
  const alive = new WeakMap<WebSocket, boolean>();

  /**
   * Who is on each open socket.
   *
   * Kept so that losing access to a project can close the shells it gave you.
   * A terminal is the strongest thing a membership grants, and it outlives the
   * request that opened it: without this, somebody removed from a project keeps
   * a live shell inside its container until they close the tab.
   */
  const holders = new Map<WebSocket, { projectId: string; userId: string }>();

  const onUpgrade = (req: Parameters<typeof handleUpgrade>[0], socket: Duplex, head: Buffer) => {
    void handleUpgrade(req, socket, head);
  };

  async function handleUpgrade(
    req: { url?: string | undefined; headers: Record<string, string | string[] | undefined> },
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    /*
     * Only this gateway's own route.
     *
     * Every gateway is attached to the same server's upgrade event, so each has
     * to leave alone what it does not serve. This one used to exclude only the
     * output route, which was right when there were two gateways and wrong once
     * there were four: it answered every events and document upgrade with a
     * 404 a moment before the gateway that owned it could accept it, so neither
     * socket ever connected in a running server. Unknown routes are refused
     * once, by the server, after every gateway has declined them.
     */
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
      // Refused before the socket exists, so the limit cannot be exceeded by
      // opening many at once and letting them all through first.
      refuse(socket, 429, 'Too many terminals');
      return;
    }

    perProject.set(projectId, (perProject.get(projectId) ?? 0) + 1);

    /*
     * Which shell, if the client asked for one it already had.
     *
     * Read from the query rather than the path so the route stays exactly one
     * shape. An identifier naming nothing is refused by the session service,
     * not quietly turned into a new shell: a client asking to get its work
     * back should not be handed a fresh prompt that looks identical to having
     * lost it.
     */
    const sessionId = sessionIdFromTerminalUrl(req.url);

    wss.handleUpgrade(req as never, socket, head, (ws) => {
      holders.set(ws, { projectId, userId });

      /*
       * The account's socket slot is given back when this one ends.
       *
       * On close rather than on detach, because a terminal session deliberately
       * outlives its socket: what is being counted is connections held, and the
       * shell carrying on afterwards costs the account nothing.
       */
      ws.on('close', () => {
        holders.delete(ws);
        decision.release();
      });

      void attach(ws, projectId, userId, sessionId);
    });
  }

  /** Joins one socket to one session, and lets go of it without ending it. */
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
    /**
     * Set when a newer socket took this session over.
     *
     * The close that follows must not detach the session, because it is no
     * longer this socket's to detach: someone else is on it.
     */
    let displaced = false;

    /*
     * Typing that arrived before the session existed.
     *
     * Opening a shell takes a moment, and the socket is open for all of it.
     * Without this, whatever was typed in that window is dropped and the
     * person sees the tail of their own command reported as an unknown
     * program. The client holds keystrokes until the socket opens; this holds
     * them until there is something to give them to.
     */
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

    /*
     * How much this one socket may send.
     *
     * Per socket, because it bounds how much work one connection can ask for
     * rather than how many connections exist. Every frame here reaches a
     * pseudo-terminal inside a container.
     *
     * A generous burst and a modest rate, because the traffic is bursty by
     * nature: pasting into a terminal is a hundred frames in a moment and
     * entirely legitimate, while a hundred a second sustained is not. Frames
     * over budget are dropped rather than closing the connection — somebody
     * whose terminal was cut off for typing quickly would rightly call that
     * broken.
     */
    const budget = new MessageBudget(options.messageBurst, options.messagesPerSecond);

    ws.on('message', (raw) => {
      if (!budget.take()) return;

      const parsed = clientMessageSchema.safeParse(safeJson(raw.toString()));
      if (!parsed.success) {
        // Dropped rather than answered. A client sending nonsense is either
        // broken or probing, and neither is worth a reply that describes the
        // protocol.
        options.log.warn({ projectId }, 'malformed terminal message');
        return;
      }
      deliver(parsed.data);
    });

    /*
     * Letting go, not shutting down.
     *
     * This is the whole change. The socket going away releases this project's
     * socket count and steps off the session; the shell keeps running, and
     * whatever it prints keeps accumulating in its scrollback for whoever
     * attaches next.
     */
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
            // The exit code is the whole point of this message, and a client
            // that never receives it reports a shell that ended as merely
            // disconnected.
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

    // The socket may already have gone while the shell was being opened.
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

    /*
     * The screen, before anything live.
     *
     * Sent after `ready` so the client knows which session it is looking at
     * before any of its content arrives, and as output rather than a message
     * of its own because that is exactly what it is: bytes this shell printed,
     * in the order it printed them.
     */
    if (attached.replay.length > 0) {
      send(ws, { type: 'output', data: attached.replay });
    }

    // Anything typed while the shell was being opened, in the order it was
    // typed. The size first, so the shell does not wrap it at the wrong width.
    if (pendingSize) deliver({ type: 'resize', size: pendingSize });
    if (pendingInput.length > 0) {
      const held = pendingInput;
      pendingInput = '';
      deliver({ type: 'input', data: held });
    }
  }

  /**
   * Drops sockets that stopped answering.
   *
   * A browser tab closed by a laptop lid, or a network that went away, leaves
   * a socket that looks open from here. Each one holds a shell in a container.
   */
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

    /**
     * Closes one person's terminals in one project.
     *
     * Called when their membership changes. The shell itself is not killed: it
     * belongs to the project and somebody still in the project may well want to
     * reattach to what it was running. What ends is this person's window onto
     * it, which is the thing their access paid for.
     */
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

/**
 * Sends a last message, then closes once it has actually gone.
 *
 * Closing immediately after sending can lose the message: the frame is queued,
 * and the close tears the connection down before it is written. A client that
 * was still finishing its end of the handshake then sees the socket end rather
 * than the reason it ended, so the platform appears to go quiet at exactly the
 * moment it had something to say.
 *
 * Found by a suite that failed roughly one run in three, always on a socket the
 * server was refusing, and always in single-digit milliseconds.
 */
function sendThenClose(ws: WebSocket, message: TerminalServerMessage): void {
  if (ws.readyState !== ws.OPEN) {
    ws.close();
    return;
  }

  ws.send(JSON.stringify(message), () => ws.close());
}

/**
 * Refuses an upgrade with a real HTTP response.
 *
 * A bare socket destroy leaves the browser reporting a generic connection
 * failure, which tells the person nothing about whether they need to sign in.
 */
function refuse(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function codeFor(error: unknown): TerminalErrorCode {
  if (error instanceof AppError) {
    // Checked before the general precondition case below, which would
    // otherwise report a full project as "start the project first".
    if (reasonOf(error) === TOO_MANY_TERMINALS) return 'TOO_MANY_TERMINALS';
    if (error.code === 'PRECONDITION_FAILED') return 'RUNTIME_NOT_RUNNING';
    if (error.code === 'RUNTIME_UNAVAILABLE') return 'RUNTIME_UNAVAILABLE';
    if (error.code === 'FORBIDDEN') return 'FORBIDDEN';
    if (error.code === 'NOT_FOUND') return 'SESSION_NOT_FOUND';
  }
  return 'EXECUTION_FAILED';
}

/** The marker a service attached to an error, when it attached one. */
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
