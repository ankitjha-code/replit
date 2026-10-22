import {
  projectEventsPath,
  projectSocketServerMessageSchema,
  type PresenceMember,
  type ProjectEvent,
  type ProjectSocketClientMessage,
} from '@platform/shared';

export type ProjectSocketStatus = 'connecting' | 'connected' | 'reconnecting' | 'refused';

export interface ProjectSocketHandlers {
  onEvent: (event: ProjectEvent) => void;
  onPresence: (members: PresenceMember[]) => void;
  onSelf?: (self: { userId: string; username: string; displayName: string }) => void;
  onConnectionChange?: (connected: boolean) => void;
  onStatusChange?: (status: ProjectSocketStatus) => void;
}

export type SocketFactory = (url: string) => WebSocket;

export function projectEventsUrl(projectId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${projectEventsPath(projectId)}`;
}

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

const POLICY_VIOLATION = 1008;

export class ProjectSocket {
  private socket: WebSocket | undefined;
  private retryMs = FIRST_RETRY_MS;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private everConnected = false;

  private file: string | null = null;

  constructor(
    private readonly url: string,
    private readonly handlers: ProjectSocketHandlers,
    private readonly factory: SocketFactory = (target) => new WebSocket(target),
  ) {
    this.connect();
  }

  setFile(file: string | null): void {
    if (file === this.file) return;
    this.file = file;
    this.post({ type: 'presence', file });
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    if (socket.readyState === WebSocket.CONNECTING) {
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
      if (this.file !== null) this.post({ type: 'presence', file: this.file });
    };

    socket.onmessage = (event: MessageEvent<string>) => this.receive(event.data);

    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.handlers.onConnectionChange?.(false);
      this.handlers.onPresence([]);
      if (event.code === POLICY_VIOLATION) {
        this.handlers.onStatusChange?.('refused');
        return;
      }
      this.scheduleRetry();
    };

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
