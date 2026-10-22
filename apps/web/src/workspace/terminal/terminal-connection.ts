import {
  serverMessageSchema,
  terminalPath,
  type TerminalClientMessage,
  type TerminalSize,
} from '@platform/shared';

export type TerminalStatus =
  | { state: 'connecting' }
  | { state: 'ready'; sessionId: string; resumed: boolean; truncated: boolean }
  | { state: 'ended'; code: number | null }
  | { state: 'closed' }
  | { state: 'failed'; message: string };

export interface TerminalHandlers {
  onOutput: (text: string) => void;
  onStatus: (status: TerminalStatus) => void;
}

export function terminalUrl(projectId: string, sessionId?: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${terminalPath(projectId, sessionId)}`;
}

export type SocketFactory = (url: string) => WebSocket;

const MAX_PENDING = 4_096;

export class TerminalConnection {
  private readonly socket: WebSocket;
  private settled = false;
  private pending = '';

  constructor(
    url: string,
    private readonly handlers: TerminalHandlers,
    factory: SocketFactory = (target) => new WebSocket(target),
  ) {
    this.handlers.onStatus({ state: 'connecting' });
    this.socket = factory(url);

    this.socket.onopen = () => this.flush();
    this.socket.onmessage = (event: MessageEvent<string>) => this.receive(event.data);

    this.socket.onerror = () => {
      this.finish({
        state: 'failed',
        message: 'The connection to the terminal failed. Check that the project is still running.',
      });
    };

    this.socket.onclose = () => this.finish({ state: 'closed' });
  }

  send(data: string): void {
    this.post({ type: 'input', data });
  }

  resize(size: TerminalSize): void {
    this.post({ type: 'resize', size });
  }

  close(): void {
    this.settled = true;
    this.socket.close();
  }

  private post(message: TerminalClientMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }

    if (message.type === 'input' && this.socket.readyState === WebSocket.CONNECTING) {
      this.pending = (this.pending + message.data).slice(-MAX_PENDING);
    }
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const held = this.pending;
    this.pending = '';
    this.post({ type: 'input', data: held });
  }

  private receive(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const message = serverMessageSchema.safeParse(parsed);
    if (!message.success) return;

    switch (message.data.type) {
      case 'ready':
        this.handlers.onStatus({
          state: 'ready',
          sessionId: message.data.sessionId,
          resumed: message.data.resumed,
          truncated: message.data.truncated,
        });
        return;
      case 'output':
        this.handlers.onOutput(message.data.data);
        return;
      case 'exit':
        this.finish({ state: 'ended', code: message.data.code });
        return;
      case 'error':
        this.finish({ state: 'failed', message: message.data.message });
        return;
    }
  }

  private finish(status: TerminalStatus): void {
    if (this.settled) return;
    this.settled = true;
    this.handlers.onStatus(status);
  }
}
