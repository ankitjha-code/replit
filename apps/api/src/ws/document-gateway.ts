import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import * as Y from 'yjs';
import {
  DOCUMENT_AWARENESS,
  DOCUMENT_MAX_MESSAGE_BYTES,
  MAX_AWARENESS_BYTES,
  DOCUMENT_SYNC_STEP_1,
  DOCUMENT_SYNC_STEP_2,
  DOCUMENT_UPDATE,
  documentClientMessageSchema,
  normalizePath,
  projectIdFromDocumentPath,
  roleHasPermission,
  type DocumentErrorCode,
  type DocumentServerMessage,
} from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../errors/app-error.js';
import {
  awarenessFrame,
  type DocumentClient,
  type DocumentSession,
  type DocumentSessionService,
} from '../modules/documents/document-session.service.js';
import { MessageBudget } from './socket-guard.js';
import { authorizeDocumentUpgrade, type UpgradeGuardDependencies } from './upgrade-guard.js';

/**
 * The socket that carries a shared document.
 *
 * Two framings, and the split is the transport's own rather than an invention:
 * binary frames are CRDT sync, text frames are JSON control messages. Nothing
 * here interprets a binary payload beyond its first byte; the whole point of a
 * CRDT is that the bytes mean the same thing on both ends without anybody in
 * the middle understanding them.
 *
 * The connection is authorized once, at upgrade, like every other socket here,
 * and carries the caller's role so the one question the upgrade cannot answer
 * (may this person type, as opposed to watch) is answered from the same
 * membership row rather than from anything the client says.
 */

export interface DocumentGatewayOptions extends UpgradeGuardDependencies {
  documents: DocumentSessionService;
  log: Logger;
  /** Editors one project may have attached at once, across everybody in it. */
  maxPerProject: number;
  heartbeatMs: number;
  /** How much one socket may send, as a burst and then a rate. */
  messageBurst: number;
  messagesPerSecond: number;
}

export interface DocumentGateway {
  readonly openCount: number;
  /** Drops one person's editors, for when their access to a project changes. */
  disconnectUser(projectId: string, userId: string): void;
  close(): Promise<void>;
}

interface Attachment {
  ws: WebSocket;
  projectId: string;
  userId: string;
  session: DocumentSession;
  client: DocumentClient;
}

/** Frames kept from before a document is ready: the handshake, and a little slack. */
const MAX_EARLY_FRAMES = 32;

export function createDocumentGateway(
  server: Server,
  options: DocumentGatewayOptions,
): DocumentGateway {
  const wss = new WebSocketServer({ noServer: true, maxPayload: DOCUMENT_MAX_MESSAGE_BYTES });

  const alive = new WeakMap<WebSocket, boolean>();
  const attachments = new Set<Attachment>();
  /** Editors per project, for the ceiling. */
  const perProject = new Map<string, number>();

  const onUpgrade = (req: Parameters<typeof handleUpgrade>[0], socket: Duplex, head: Buffer) => {
    void handleUpgrade(req, socket, head);
  };

  async function handleUpgrade(
    req: { url?: string | undefined; headers: Record<string, string | string[] | undefined> },
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    // Not this gateway's route, so one of the others will take it.
    const url = parseUrl(req.url);
    if (!url || !projectIdFromDocumentPath(url.pathname)) return;

    /*
     * The path is validated here rather than trusted from the query.
     *
     * It becomes a lookup in the files table and, on the way back out, a write.
     * Everything else in the platform normalises a path exactly once, on the
     * way in, and this is that moment for this socket.
     */
    const requested = url.searchParams.get('path');
    const normalized = requested === null ? undefined : normalizePath(requested);

    if (!normalized?.ok || !normalized.path) {
      refuse(socket, 400, 'Bad Request');
      return;
    }
    const path = normalized.path;

    let decision;
    try {
      decision = await authorizeDocumentUpgrade(options, {
        url: req.url,
        headers: { origin: single(req.headers.origin), cookie: single(req.headers.cookie) },
        address: addressOf(socket),
      });
    } catch (error) {
      options.log.error({ err: error }, 'document upgrade check failed');
      refuse(socket, 500, 'Internal Server Error');
      return;
    }

    if (!decision.ok) {
      refuse(socket, decision.status, decision.message);
      return;
    }

    const { projectId, userId, username, displayName, role } = decision;

    if ((perProject.get(projectId) ?? 0) >= options.maxPerProject) {
      refuse(socket, 429, 'Too many open documents');
      return;
    }

    wss.handleUpgrade(req as never, socket, head, (ws) => {
      // The account's socket slot, given back when this connection ends.
      // Idempotent, because a socket ends in more than one way.
      ws.on('close', () => decision.release());
      ws.on('error', () => decision.release());

      void attach(ws, {
        projectId,
        path,
        userId,
        username,
        displayName: displayName ?? username,
        // The one decision the upgrade itself does not make. A viewer gets the
        // socket and a read-only editor; an editor gets both.
        canWrite: roleHasPermission(role, 'file:write'),
      });
    });
  }

  async function attach(
    ws: WebSocket,
    who: {
      projectId: string;
      path: string;
      userId: string;
      username: string;
      displayName: string;
      canWrite: boolean;
    },
  ): Promise<void> {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));

    /*
     * Frames that arrive before the document is ready are held, not lost.
     *
     * A browser sends its half of the handshake the moment the socket opens,
     * and for the first person into a file that is while the file is still
     * being loaded below. With no listener yet, `ws` simply drops the frame: the
     * client never got the file's content, and its CRDT then held back every
     * later update as depending on text it did not have. Found with two real
     * browsers; bounded, because a client has no reason to send much before it
     * has been told it is in.
     */
    const early: { raw: Buffer; isBinary: boolean }[] = [];
    const hold = (raw: Buffer, isBinary: boolean): void => {
      if (early.length < MAX_EARLY_FRAMES) early.push({ raw, isBinary });
    };
    ws.on('message', hold);

    const client: DocumentClient = {
      userId: who.userId,
      username: who.username,
      displayName: who.displayName,
      canWrite: who.canWrite,
      send: (frame) => {
        if (ws.readyState === ws.OPEN) ws.send(frame, { binary: true });
      },
      notify: (message) => send(ws, message),
    };

    let session: DocumentSession;
    try {
      session = await options.documents.join(who.projectId, who.path, client);
    } catch (error) {
      sendThenClose(ws, {
        type: 'error',
        code: refusalCodeOf(error),
        message:
          error instanceof AppError && error.expose
            ? error.message
            : messageFor(refusalCodeOf(error)),
      });
      return;
    }

    /*
     * The socket may already be gone.
     *
     * Loading a file is a database round trip, and somebody who closed the tab
     * during it would otherwise leave a document open with a client attached
     * that can never be told anything.
     */
    if (ws.readyState !== ws.OPEN) {
      await options.documents.leave(session, client);
      return;
    }

    const attachment: Attachment = {
      ws,
      projectId: who.projectId,
      userId: who.userId,
      session,
      client,
    };
    attachments.add(attachment);
    perProject.set(who.projectId, (perProject.get(who.projectId) ?? 0) + 1);

    /*
     * Everything the document changes, sent to everybody but the author.
     *
     * Skipping the author is not an optimisation: their editor already has the
     * change, and applying it again is harmless to the CRDT but sends the text
     * back through the binding, which is where a cursor jumps.
     */
    const onUpdate = (update: Uint8Array, origin: unknown): void => {
      if (origin === client) return;
      client.send(frame(DOCUMENT_UPDATE, update));
    };
    session.doc.on('update', onUpdate);

    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;

      session.doc.off('update', onUpdate);
      attachments.delete(attachment);

      const count = (perProject.get(who.projectId) ?? 1) - 1;
      if (count <= 0) perProject.delete(who.projectId);
      else perProject.set(who.projectId, count);

      await options.documents.leave(session, client);
    };

    ws.on('close', () => void release());
    ws.on('error', () => void release());

    /*
     * How much this one socket may send.
     *
     * Per socket rather than per account, because it bounds a different thing
     * from the connection limits: not how many connections exist but how much
     * work one of them can ask for. Every frame here reaches a CRDT, which does
     * real work per update.
     *
     * Over-budget frames are dropped rather than closing the connection. A
     * client that oversteps is far more often a burst of typing than an attack,
     * and cutting an editor off would lose work in order to prevent a cost.
     */
    const budget = new MessageBudget(options.messageBurst, options.messagesPerSecond);

    const onMessage = (raw: Buffer, isBinary: boolean): void => {
      if (!budget.take()) return;

      if (isBinary) {
        receive(session, client, raw);
        return;
      }

      /*
       * Text frames are control messages.
       *
       * The only one a client may send is a keepalive, which needs no reply:
       * receiving it has already reset the socket's idle timer. It is parsed
       * rather than ignored so that the one place a client message could be
       * accepted is the one place that decides what an acceptable one is.
       * Anything else is dropped in silence, as on every other socket here.
       */
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }

      const message = documentClientMessageSchema.safeParse(parsed);
      if (!message.success) return;
    };

    send(ws, {
      type: 'ready',
      path: who.path,
      canWrite: who.canWrite,
      participants: session.participants(),
    });

    /*
     * The server opens the handshake by saying what it has.
     *
     * The client replies with only what the server is missing, and asks for
     * what it is missing in turn. Symmetrical because either side can be the
     * one that is behind: a client reconnecting after a dropped connection is
     * behind everything, and a server that just loaded the file from the
     * database is behind every character typed since.
     */
    client.send(frame(DOCUMENT_SYNC_STEP_1, Y.encodeStateVector(session.doc)));

    // Now the real listener, then whatever arrived while the file was loading,
    // in the order it arrived.
    ws.off('message', hold);
    ws.on('message', onMessage);
    for (const held of early.splice(0)) onMessage(held.raw, held.isBinary);

    // Where everybody already is, so a newcomer sees cursors straight away
    // rather than only once each person next moves.
    const snapshot = session.awarenessSnapshot();
    if (snapshot) client.send(awarenessFrame(snapshot));
  }

  /** One binary frame from a client. */
  function receive(session: DocumentSession, client: DocumentClient, raw: Buffer): void {
    if (raw.length < 1) return;

    const type = raw[0];
    const payload = new Uint8Array(raw.subarray(1));

    try {
      switch (type) {
        case DOCUMENT_SYNC_STEP_1:
          // They have told us what they hold; send exactly what they lack.
          client.send(frame(DOCUMENT_SYNC_STEP_2, Y.encodeStateAsUpdate(session.doc, payload)));
          return;

        case DOCUMENT_SYNC_STEP_2:
        case DOCUMENT_UPDATE: {
          const applied = options.documents.applyUpdate(session, client, payload);
          if (!applied) {
            client.notify({
              type: 'stale',
              message:
                'Your access to this project does not allow editing, so this change was not applied.',
            });
          }
          return;
        }

        case DOCUMENT_AWARENESS: {
          // Bounded before anything decodes it: this is attacker-reachable, and
          // a cursor is a few dozen bytes.
          if (payload.byteLength > MAX_AWARENESS_BYTES) return;

          const accepted = session.acceptAwareness(client, payload);
          if (!accepted) return;

          // To everybody else, re-stamped with the names the server trusts.
          const outgoing = awarenessFrame(accepted);
          for (const other of session.clients) {
            if (other !== client) other.send(outgoing);
          }
          return;
        }

        default:
          // An unknown type is a client speaking a protocol this one does not.
          return;
      }
    } catch (error) {
      /*
       * A malformed update.
       *
       * The CRDT library throws on payloads it cannot decode, and this is
       * attacker-reachable input: the frame is dropped and the document is left
       * exactly as it was. The socket stays open, because one bad frame from
       * one client says nothing about the others attached to the same file.
       */
      options.log.warn(
        { err: error, projectId: session.projectId, path: session.path },
        'a document frame could not be applied',
      );
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

    /**
     * Closes one person's editors in one project.
     *
     * Called when their membership changes. The socket is closed rather than
     * quietly downgraded, because their client then reconnects and is
     * authorized again from scratch: a role is decided at upgrade, so the only
     * honest way to apply a new one is a new upgrade.
     */
    disconnectUser(projectId, userId) {
      for (const attachment of [...attachments]) {
        if (attachment.projectId !== projectId || attachment.userId !== userId) continue;
        attachment.ws.close(1008, 'Access to this project changed');
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

/** A type byte followed by an opaque payload. */
function frame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.byteLength + 1);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

function send(ws: WebSocket, message: DocumentServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

/**
 * Says why, then closes.
 *
 * Closing immediately after `send` discards what was queued, which once cost
 * the terminal gateway every one of its refusal messages. The close waits for
 * the frame to leave.
 */
function sendThenClose(ws: WebSocket, message: DocumentServerMessage): void {
  if (ws.readyState !== ws.OPEN) {
    ws.close();
    return;
  }
  ws.send(JSON.stringify(message), () => ws.close());
}

/** The document socket's own name for a refusal the service raised. */
function refusalCodeOf(error: unknown): DocumentErrorCode {
  if (!(error instanceof AppError)) return 'STORAGE_FAILED';

  switch (error.code) {
    case 'NOT_FOUND':
      return 'NOT_FOUND';
    case 'BAD_REQUEST':
    case 'VALIDATION_FAILED':
      return 'UNSUPPORTED';
    case 'PAYLOAD_TOO_LARGE':
      return 'TOO_MANY_DOCUMENTS';
    default:
      return 'STORAGE_FAILED';
  }
}

function messageFor(code: DocumentErrorCode): string {
  switch (code) {
    case 'NOT_FOUND':
      return 'That file does not exist.';
    case 'UNSUPPORTED':
      return 'This file cannot be edited here.';
    case 'READ_ONLY':
      return 'Your access to this project does not allow editing.';
    case 'TOO_MANY_DOCUMENTS':
      return 'Too many files are open for editing in this project.';
    case 'STORAGE_FAILED':
      return 'This file could not be opened for editing.';
  }
}

function refuse(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function parseUrl(url: string | undefined): URL | undefined {
  if (!url) return undefined;
  try {
    // The base is never used; it only makes a relative URL parseable.
    return new URL(url, 'http://placeholder.invalid');
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
