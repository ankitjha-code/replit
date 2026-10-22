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
 * is told. That keeps the part with rules in it (reconnecting, validating,
 * backing off) testable without a component tree.
 *
 * Every frame from the server is validated before it is acted on. The socket is
 * authenticated, but "it arrived on a connection we trust" has never been a
 * reason to treat text as a shape.
 */

/**
 * What the stream is doing, for the one fixed spot in the toolbar that says so.
 *
 * `connecting` is the first attempt; `reconnecting` is every later one, which
 * the UI may show after a grace period. `refused` means the server closed the
 * socket because this account may no longer see the project, and no retry
 * will change that.
 */
export type ProjectSocketStatus = 'connecting' | 'connected' | 'reconnecting' | 'refused';

export interface ProjectSocketHandlers {
  /** Something changed in the project. */
  onEvent: (event: ProjectEvent) => void;
  /** The roster changed, including on first connection. */
  onPresence: (members: PresenceMember[]) => void;
  /** Who the server says we are, sent once per connection. */
  onSelf?: (self: { userId: string; username: string; displayName: string }) => void;
  /** Whether the stream is currently live, so a client can say when it is not. */
  onConnectionChange?: (connected: boolean) => void;
  /** The finer-grained state behind `onConnectionChange`. */
  onStatusChange?: (status: ProjectSocketStatus) => void;
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

/**
 * The close code every gateway uses when the account lost access to the
 * project (a revoked membership, an ended session). Retrying would only ask
 * the same question again; the shell's session banner takes over instead.
 */
const POLICY_VIOLATION = 1008;

export class ProjectSocket {
  private socket: WebSocket | undefined;
  private retryMs = FIRST_RETRY_MS;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private everConnected = false;

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
    if (!socket) return;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    if (socket.readyState === WebSocket.CONNECTING) {
      // Closing a socket that has not finished opening makes the browser log
      // "WebSocket is closed before the connection is established" (React's
      // development double-mount does this on every load). Letting it open
      // and then closing it is quiet, and costs the server one empty session.
      socket.onopen = () => socket.close();
      return;
    }
    socket.onopen = null;
    socket.close();
  }

  private connect(): void {
    this.handlers.onStatusChange?.(this.everConnected ? 'reconnecting' : 'connecting');
    const socket = this.factory(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.retryMs = FIRST_RETRY_MS;
      this.everConnected = true;
      this.handlers.onConnectionChange?.(true);
      this.handlers.onStatusChange?.('connected');
      // Tell the server where we are, since it has no memory of us.
      if (this.file !== null) this.post({ type: 'presence', file: this.file });
    };

    socket.onmessage = (event: MessageEvent<string>) => this.receive(event.data);

    socket.onclose = (event: CloseEvent) => {
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
      if (event.code === POLICY_VIOLATION) {
        this.handlers.onStatusChange?.('refused');
        return;
      }
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

    this.handlers.onStatusChange?.('reconnecting');
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
