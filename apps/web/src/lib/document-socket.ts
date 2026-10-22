import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import {
  DOCUMENT_SYNC_STEP_1,
  DOCUMENT_SYNC_STEP_2,
  DOCUMENT_UPDATE,
  DOCUMENT_AWARENESS,
  documentPath,
  documentServerMessageSchema,
  type DocumentErrorCode,
  type DocumentParticipant,
} from '@platform/shared';

/**
 * The browser's half of a shared document.
 *
 * Holds a Yjs document, keeps it in step with the server's, and says nothing
 * about how it is displayed. The editor binding is somewhere else entirely,
 * which is what lets the rules here be reasoned about without a Monaco
 * instance in the room.
 *
 * Two framings, matching the server: binary frames are CRDT sync and text
 * frames are JSON control messages. Control messages are validated; sync frames
 * are handed to the CRDT, which is the only thing that understands them.
 */

export interface DocumentHandlers {
  /** The server accepted the connection. */
  onReady: (state: { canWrite: boolean; participants: DocumentParticipant[] }) => void;
  onParticipants: (participants: DocumentParticipant[]) => void;
  /** The platform wrote the file back. */
  onSaved: (at: string) => void;
  /**
   * The file changed outside this editor, so it is no longer being saved.
   *
   * Not an error and not a disconnection: everything typed is still here and
   * still shared. It is a warning that it is no longer being written down.
   */
  onStale: (message: string) => void;
  onError: (error: { code: DocumentErrorCode; message: string }) => void;
  onConnectionChange: (connected: boolean) => void;
}

/** Injectable so tests can drive a socket without a server. */
export type SocketFactory = (url: string) => WebSocket;

export function documentUrl(projectId: string, path: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${documentPath(projectId, path)}`;
}

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export class DocumentConnection {
  /**
   * The shared text, which outlives any one connection.
   *
   * Deliberately created here and never replaced. A reconnection re-syncs this
   * same document rather than building a new one, so characters typed while the
   * connection was down are still there and are merged on the way back in. That
   * is the entire reason for using a CRDT rather than sending text.
   */
  readonly doc = new Y.Doc();

  /**
   * Where this person's cursor is, and everybody else's.
   *
   * The server re-stamps every participant's name and colour from their
   * account, so what arrives here is trusted for display — and is still checked
   * before it reaches a stylesheet, because a check on both ends is cheap.
   */
  readonly awareness = new Awareness(this.doc);

  private socket: WebSocket | undefined;
  private retryMs = FIRST_RETRY_MS;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  /** False until the server says otherwise, so nothing is sent by a viewer. */
  private canWrite = false;

  constructor(
    private readonly url: string,
    private readonly handlers: DocumentHandlers,
    private readonly factory: SocketFactory = (target) => new WebSocket(target),
  ) {
    /*
     * Local changes go out; everything else does not.
     *
     * `origin` is how a CRDT tells its own applied-from-the-network updates
     * apart from what was typed here. Without the check, every update received
     * would be echoed straight back, and two clients would keep each other busy
     * forever over one keystroke.
     */
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return;
      this.post(DOCUMENT_UPDATE, update);
    });

    // This person's own cursor moves go out; everybody else's arrive below.
    this.awareness.on(
      'update',
      (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin === REMOTE) return;
        const ids = [...changes.added, ...changes.updated, ...changes.removed];
        if (ids.length === 0) return;
        this.post(DOCUMENT_AWARENESS, encodeAwarenessUpdate(this.awareness, ids));
      },
    );

    this.connect();
  }

  get text(): Y.Text {
    // The same root name the server uses. Two roots would be two documents.
    return this.doc.getText('content');
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);

    // Tells the others this cursor has gone, while the socket can still say so.
    // (The server also removes it when the socket drops; this is just sooner.)
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'closed');

    // Detached before closing, so the close handler does not schedule a retry
    // for a socket that was closed on purpose.
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();

    this.awareness.destroy();
    this.doc.destroy();
  }

  private connect(): void {
    const socket = this.factory(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.retryMs = FIRST_RETRY_MS;
      this.handlers.onConnectionChange(true);
      // Say what we already hold. The server replies with what we are missing,
      // which after a reconnection is everything typed by everybody else.
      this.post(DOCUMENT_SYNC_STEP_1, Y.encodeStateVector(this.doc));
    };

    socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      if (typeof event.data === 'string') this.control(event.data);
      else this.sync(new Uint8Array(event.data));
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.canWrite = false;
      this.handlers.onConnectionChange(false);
      this.scheduleRetry();
    };

    // A failed socket always closes as well, and a browser never says why one
    // failed. Handling both would report the same loss twice.
    socket.onerror = () => undefined;
  }

  private scheduleRetry(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }

  private control(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const message = documentServerMessageSchema.safeParse(parsed);
    if (!message.success) return;

    switch (message.data.type) {
      case 'ready':
        this.canWrite = message.data.canWrite;
        this.handlers.onReady({
          canWrite: message.data.canWrite,
          participants: message.data.participants,
        });
        return;
      case 'participants':
        this.handlers.onParticipants(message.data.participants);
        return;
      case 'saved':
        this.handlers.onSaved(message.data.at);
        return;
      case 'stale':
        this.handlers.onStale(message.data.message);
        return;
      case 'error':
        this.handlers.onError({ code: message.data.code, message: message.data.message });
        // A refusal is final: the server closes straight after, and retrying
        // would produce the same refusal on a timer.
        this.closed = true;
        return;
    }
  }

  private sync(frame: Uint8Array): void {
    if (frame.length < 1) return;

    const type = frame[0];
    const payload = frame.subarray(1);

    try {
      switch (type) {
        case DOCUMENT_SYNC_STEP_1:
          // The server has said what it holds. Reply with what it lacks.
          this.post(DOCUMENT_SYNC_STEP_2, Y.encodeStateAsUpdate(this.doc, payload));
          return;
        case DOCUMENT_SYNC_STEP_2:
        case DOCUMENT_UPDATE:
          Y.applyUpdate(this.doc, payload, REMOTE);
          return;
        case DOCUMENT_AWARENESS:
          applyAwarenessUpdate(this.awareness, payload, REMOTE);
          return;
        default:
          return;
      }
    } catch {
      /*
       * A frame the CRDT could not decode.
       *
       * Dropped, leaving the document exactly as it was. The connection is kept:
       * one unreadable frame says nothing about the next, and tearing down the
       * editor would lose whatever is not yet written back.
       */
    }
  }

  private post(type: number, payload: Uint8Array): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    // A viewer's editor is read-only, so this should never have anything to
    // send. Checked anyway: the server refuses it too, and the two agreeing is
    // what keeps a refused keystroke from appearing to work locally.
    if (type === DOCUMENT_UPDATE && !this.canWrite) return;

    const frame = new Uint8Array(payload.byteLength + 1);
    frame[0] = type;
    frame.set(payload, 1);
    this.socket.send(frame);
  }
}

/**
 * Marks an update as having come from the server.
 *
 * Any unique value would do; a symbol is used so it cannot collide with
 * anything else that sets an origin on this document.
 */
const REMOTE = Symbol('remote');
