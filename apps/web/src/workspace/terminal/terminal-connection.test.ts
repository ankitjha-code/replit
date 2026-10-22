import { describe, expect, it, vi } from 'vitest';
import { TerminalConnection, terminalUrl, type TerminalStatus } from './terminal-connection.js';

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState: number = FakeSocket.OPEN;
  readonly sent: string[] = [];
  closed = false;

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  receive(raw: string): void {
    this.onmessage?.({ data: raw } as MessageEvent<string>);
  }

  fail(): void {
    this.onerror?.();
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
}

function connect(readyState: number = FakeSocket.OPEN) {
  const socket = new FakeSocket();
  socket.readyState = readyState;
  const output: string[] = [];
  const statuses: TerminalStatus[] = [];

  const connection = new TerminalConnection(
    'ws://test/terminal',
    {
      onOutput: (text) => output.push(text),
      onStatus: (status) => statuses.push(status),
    },
    () => socket as unknown as WebSocket,
  );

  return { socket, output, statuses, connection, last: () => statuses[statuses.length - 1] };
}

describe('connecting', () => {
  it('says it is connecting before anything has happened', () => {
    const { statuses } = connect();
    expect(statuses[0]).toEqual({ state: 'connecting' });
  });

  it('says it is ready once the server attaches a shell', () => {
    const { socket, last } = connect();
    socket.receive(
      JSON.stringify({ type: 'ready', sessionId: 's-1', resumed: false, truncated: false }),
    );
    expect(last()).toEqual({
      state: 'ready',
      sessionId: 's-1',
      resumed: false,
      truncated: false,
    });
  });

  it('carries the session it attached to, so the next page can ask for it again', () => {
    const { socket, last } = connect();
    socket.receive(
      JSON.stringify({ type: 'ready', sessionId: 'abc-123', resumed: true, truncated: false }),
    );
    const status = last();
    expect(status).toMatchObject({ state: 'ready', sessionId: 'abc-123', resumed: true });
  });

  it('reports a rebuilt screen as incomplete when the server said it was', () => {
    const { socket, last } = connect();
    socket.receive(
      JSON.stringify({ type: 'ready', sessionId: 's-1', resumed: true, truncated: true }),
    );
    expect(last()).toMatchObject({ truncated: true });
  });

  it('refuses a ready message that does not say which session it is', () => {
    const { socket, last } = connect();
    socket.receive(JSON.stringify({ type: 'ready' }));
    expect(last()).toEqual({ state: 'connecting' });
  });
});

describe('addressing a session', () => {
  it('asks for no particular shell when none is named', () => {
    expect(terminalUrl('p1')).toBe('ws://localhost:3000/ws/projects/p1/terminal');
  });

  it('asks to resume a shell by name', () => {
    expect(terminalUrl('p1', 's-9')).toBe(
      'ws://localhost:3000/ws/projects/p1/terminal?session=s-9',
    );
  });

  it('escapes an identifier rather than letting it change the address', () => {
    const url = terminalUrl('p1', 'a&b=c');
    expect(url).toContain('session=a%26b%3Dc');
  });
});

describe('what the server says', () => {
  it('passes output through unchanged', () => {
    const { socket, output } = connect();
    socket.receive(JSON.stringify({ type: 'output', data: 'hello\r\n$ ' }));
    expect(output).toEqual(['hello\r\n$ ']);
  });

  it('reports the shell exiting, with its code', () => {
    const { socket, last } = connect();
    socket.receive(JSON.stringify({ type: 'exit', code: 130 }));
    expect(last()).toEqual({ state: 'ended', code: 130 });
  });

  it('shows a refusal in the server own words', () => {
    const { socket, last } = connect();
    socket.receive(
      JSON.stringify({
        type: 'error',
        code: 'RUNTIME_NOT_RUNNING',
        message: 'Start the project before opening a terminal.',
      }),
    );
    expect(last()).toEqual({
      state: 'failed',
      message: 'Start the project before opening a terminal.',
    });
  });

  it('ignores a message the protocol does not describe', () => {
    const { socket, output, statuses } = connect();
    const before = statuses.length;

    socket.receive('not json');
    socket.receive(JSON.stringify({ type: 'output' }));
    socket.receive(JSON.stringify({ type: 'eval', data: 'anything' }));
    socket.receive(JSON.stringify({ type: 'output', data: 42 }));

    expect(output).toEqual([]);
    expect(statuses).toHaveLength(before);
  });

  it('reports only the first ending', () => {
    const { socket, last } = connect();
    socket.receive(
      JSON.stringify({ type: 'error', code: 'FORBIDDEN', message: 'Not allowed here.' }),
    );
    socket.close();

    expect(last()).toEqual({ state: 'failed', message: 'Not allowed here.' });
  });

  it('reports a drop that was nobody decision', () => {
    const { socket, last } = connect();
    socket.receive(JSON.stringify({ type: 'ready' }));
    socket.close();

    expect(last()).toEqual({ state: 'closed' });
  });

  it('says what to check when the socket errors', () => {
    const { socket, last } = connect();
    socket.fail();

    expect(last()).toMatchObject({ state: 'failed' });
    expect((last() as { message: string }).message).toContain('still running');
  });
});

describe('what the client sends', () => {
  it('sends keystrokes as input', () => {
    const { socket, connection } = connect();
    connection.send('ls -la\r');
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: 'input', data: 'ls -la\r' });
  });

  it('sends a resize when the window changes', () => {
    const { socket, connection } = connect();
    connection.resize({ columns: 120, rows: 40 });
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: 'resize',
      size: { columns: 120, rows: 40 },
    });
  });

  it('does not send into a socket that has closed', () => {
    const { socket, connection } = connect();
    socket.readyState = 3;
    connection.send('lost');
    expect(socket.sent).toEqual([]);
  });

  it('holds typing that arrives before the socket opens', () => {
    const { socket, connection } = connect(FakeSocket.CONNECTING);

    connection.send('cad');
    connection.send('dy --version');
    expect(socket.sent).toEqual([]);

    socket.open();

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: 'input',
      data: 'caddy --version',
    });
  });

  it('holds nothing when nothing was typed', () => {
    const { socket } = connect(FakeSocket.CONNECTING);
    socket.open();
    expect(socket.sent).toEqual([]);
  });

  it('does not hold a resize, which is only true of a moment', () => {
    const { socket, connection } = connect(FakeSocket.CONNECTING);
    connection.resize({ columns: 80, rows: 24 });
    socket.open();

    expect(socket.sent).toEqual([]);
  });

  it('closing is not reported as the connection dropping', () => {
    const { connection, last, statuses } = connect();
    const before = statuses.length;
    connection.close();

    expect(statuses).toHaveLength(before);
    expect(last()).toEqual({ state: 'connecting' });
  });
});

describe('the address', () => {
  it('uses the page own origin, and matches its scheme', () => {
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { protocol: 'https:', host: 'platform.example' },
    });

    expect(terminalUrl('abc')).toBe('wss://platform.example/ws/projects/abc/terminal');

    Object.defineProperty(window, 'location', { configurable: true, value: original });
  });

  it('falls back to the unencrypted scheme on a plain page', () => {
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { protocol: 'http:', host: 'localhost:5173' },
    });

    expect(terminalUrl('abc')).toBe('ws://localhost:5173/ws/projects/abc/terminal');

    Object.defineProperty(window, 'location', { configurable: true, value: original });
  });
});

describe('the socket it opens', () => {
  it('opens exactly one, at the address it was given', () => {
    const factory = vi.fn(() => new FakeSocket() as unknown as WebSocket);
    new TerminalConnection('ws://test/x', { onOutput: () => {}, onStatus: () => {} }, factory);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith('ws://test/x');
  });
});
