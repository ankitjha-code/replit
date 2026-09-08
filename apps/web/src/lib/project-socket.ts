import {
  projectEventsPath,
  projectSocketServerMessageSchema,
  type PresenceMember,
  type ProjectEvent,
  type ProjectSocketClientMessage,
} from '@platform/shared';

/**
 * The browser's half of a project's event and presence socket.
 *
 * Knows nothing about React and nothing about what any panel does with what it
 * is told. That keeps the part with rules in it — reconnecting, validating,
 * backing off — testable without a component tree.
 *
 * Every frame from the server is validated before it is acted on. The socket is
 * authenticated, but "it arrived on a connection we trust" has never been a
 * reason to treat text as a shape.
 */

export interface ProjectSocketHandlers {
  /** Something changed in the project. */
  onEvent: (event: ProjectEvent) => void;
  /** The roster changed, including on first connection. */
  onPresence: (members: PresenceMember[]) => void;
  /** Who the server says we are, sent once per connection. */
  onSelf?: (self: { userId: string; username: string; displayName: string }) => void;
  /** Whether the stream is currently live, so a client can say when it is not. */
  onConnectionChange?: (connected: boolean) => void;
}

/** Injectable so tests can drive a socket without a server. */
export type SocketFactory = (url: string) => WebSocket;

export function projectEventsUrl(projectId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${projectEventsPath(projectId)}`;
}

/**
 * How long to wait before trying again, growing with each failure.
 *
 * A workspace left open overnight on a laptop that slept will reconnect, and it
 * must not become a client that hammers a server it cannot reach. The delay
 * grows to a ceiling and resets the moment a connection succeeds.
 */
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export class ProjectSocket {
  private socket: WebSocket | undefined;
  private retryMs = FIRST_RETRY_MS;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  /**
   * The file last reported, kept so it can be sent again after a reconnect.
   *
   * Presence lives in the server's memory, so a reconnected client is a new
   * arrival that has said nothing about itself. Without this it would show as
   * present but nowhere for as long as it took somebody to click another file.
   */
  private file: string | null = null;

  constructor(
    private readonly url: string,
    private readonly handlers: ProjectSocketHandlers,
    private readonly factory: SocketFactory = (target) => new WebSocket(target),
  ) {
    this.connect();
  }

  /** Says which file this window is looking at. Null means none. */
  setFile(file: string | null): void {
    if (file === this.file) return;
    this.file = file;
    this.post({ type: 'presence', file });
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    // Detached before closing, so the close handler does not schedule a retry
    // for a socket that was closed on purpose.
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private connect(): void {
    const socket = this.factory(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.retryMs = FIRST_RETRY_MS;
      this.handlers.onConnectionChange?.(true);
      // Tell the server where we are, since it has no memory of us.
      if (this.file !== null) this.post({ type: 'presence', file: this.file });
    };

    socket.onmessage = (event: MessageEvent<string>) => this.receive(event.data);

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.handlers.onConnectionChange?.(false);
      /*
       * An empty roster while disconnected.
       *
       * Leaving the last one on screen would be the one genuinely misleading
       * thing this component could do: it would show people as present long
       * after the connection that knew about them had gone.
       */
      this.handlers.onPresence([]);
      this.scheduleRetry();
    };

    /*
     * Nothing on error.
     *
     * A failed socket always closes as well, and a browser never says why one
     * failed. Handling both would report the same loss twice.
     */
    socket.onerror = () => undefined;
  }

  private scheduleRetry(): void {
    if (this.closed) return;

    this.timer = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }

  private post(message: ProjectSocketClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private receive(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const message = projectSocketServerMessageSchema.safeParse(parsed);
    // Anything the protocol does not describe is dropped in silence, as on
    // every other socket in this codebase.
    if (!message.success) return;

    switch (message.data.type) {
      case 'hello':
        this.handlers.onSelf?.(message.data.self);
        this.handlers.onPresence(message.data.members);
        return;
      case 'presence':
        this.handlers.onPresence(message.data.members);
        return;
      case 'event':
        this.handlers.onEvent(message.data.event);
        return;
    }
  }
}
