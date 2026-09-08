import {
  serverMessageSchema,
  terminalPath,
  type TerminalClientMessage,
  type TerminalSize,
} from '@platform/shared';

/**
 * The browser's half of the terminal protocol.
 *
 * Deliberately knows nothing about how a terminal is drawn. Everything here is
 * about the connection: what state it is in, what it will send, and what it
 * refuses to believe. That keeps the part with rules in it testable without a
 * canvas, a font or a container.
 *
 * Messages from the server are validated before they are acted on. The socket
 * is authenticated, but "it arrived on a trusted connection" is not a reason to
 * hand unvalidated text to a terminal emulator.
 */

export type TerminalStatus =
  | { state: 'connecting' }
  /**
   * Attached to a shell.
   *
   * `resumed` says the shell was already running, which is worth telling
   * someone: a prompt that appears with their work still on it should not be
   * indistinguishable from a fresh one. `truncated` says the screen above was
   * rebuilt from a window that had already dropped its oldest bytes.
   */
  | { state: 'ready'; sessionId: string; resumed: boolean; truncated: boolean }
  /** The shell exited. Normal: someone typed `exit`. */
  | { state: 'ended'; code: number | null }
  /** The connection dropped without the shell ending. */
  | { state: 'closed' }
  /** Refused, or broken. The message is safe to show. */
  | { state: 'failed'; message: string };

export interface TerminalHandlers {
  onOutput: (text: string) => void;
  onStatus: (status: TerminalStatus) => void;
}

/**
 * The socket address for a project's terminal, on this same origin.
 *
 * With a session identifier it asks to resume that shell, which is what makes
 * a reload come back to a running build rather than killing it.
 */
export function terminalUrl(projectId: string, sessionId?: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${terminalPath(projectId, sessionId)}`;
}

/** Injectable so tests can drive a socket without a server. */
export type SocketFactory = (url: string) => WebSocket;

/**
 * How much typing is held while the socket is still opening.
 *
 * Generous for the handful of characters someone types into a terminal that
 * has just appeared, and small enough that a buffer cannot grow without bound
 * if the socket never opens.
 */
const MAX_PENDING = 4_096;

export class TerminalConnection {
  private readonly socket: WebSocket;
  private settled = false;
  /**
   * Typing that arrived before the socket opened.
   *
   * A terminal appears the moment a project starts, and someone clicking into
   * it and typing immediately is ordinary. Dropping those characters loses the
   * first word of a command and leaves the shell reporting an error about a
   * program nobody asked for.
   */
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
      // A browser never says why a socket failed, on purpose: the detail would
      // leak cross-origin information. So the message here describes what to
      // do rather than pretending to know what happened.
      this.finish({
        state: 'failed',
        message: 'The connection to the terminal failed. Check that the project is still running.',
      });
    };

    this.socket.onclose = () => this.finish({ state: 'closed' });
  }

  /** Keystrokes, or a paste. */
  send(data: string): void {
    this.post({ type: 'input', data });
  }

  resize(size: TerminalSize): void {
    this.post({ type: 'resize', size });
  }

  close(): void {
    // Settled first, so the close this causes is not reported as the
    // connection dropping on its own.
    this.settled = true;
    this.socket.close();
  }

  private post(message: TerminalClientMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }

    // Held only while the socket is still opening. Once it has closed, there
    // is nothing to hold it for.
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
    // Anything the protocol does not describe is dropped. Passing unknown text
    // to a terminal emulator means passing escape sequences to it.
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

  /**
   * Reports the first ending and ignores the rest.
   *
   * A refused connection produces an error message and then a close, and a
   * shell that exits produces an exit and then a close. Only the first says
   * anything useful; the close that follows would overwrite it with something
   * vaguer.
   */
  private finish(status: TerminalStatus): void {
    if (this.settled) return;
    this.settled = true;
    this.handlers.onStatus(status);
  }
}
