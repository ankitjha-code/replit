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

export interface DocumentHandlers {
  onReady: (state: { canWrite: boolean; participants: DocumentParticipant[] }) => void;
  onParticipants: (participants: DocumentParticipant[]) => void;
  onSaved: (at: string) => void;
  onStale: (message: string) => void;
  onError: (error: { code: DocumentErrorCode; message: string }) => void;
  onConnectionChange: (connected: boolean) => void;
}

export type SocketFactory = (url: string) => WebSocket;

export function documentUrl(projectId: string, path: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${documentPath(projectId, path)}`;
}

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export class DocumentConnection {
  readonly doc = new Y.Doc();

  readonly awareness = new Awareness(this.doc);

  private socket: WebSocket | undefined;
  private retryMs = FIRST_RETRY_MS;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private canWrite = false;

  constructor(
    private readonly url: string,
    private readonly handlers: DocumentHandlers,
    private readonly factory: SocketFactory = (target) => new WebSocket(target),
  ) {
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return;
      this.post(DOCUMENT_UPDATE, update);
    });

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
    return this.doc.getText('content');
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);

    removeAwarenessStates(this.awareness, [this.doc.clientID], 'closed');

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
    } catch {}
  }

  private post(type: number, payload: Uint8Array): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (type === DOCUMENT_UPDATE && !this.canWrite) return;

    const frame = new Uint8Array(payload.byteLength + 1);
    frame[0] = type;
    frame.set(payload, 1);
    this.socket.send(frame);
  }
}

const REMOTE = Symbol('remote');
