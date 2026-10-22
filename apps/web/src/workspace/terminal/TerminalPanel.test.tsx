import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeStateResponse, RuntimeStatus } from '@platform/shared';
import { NO_WORKSPACE_ACTIONS, WorkspaceActionsContext } from '../shell/workspace-actions.js';
import { TerminalPanel, TerminalStatusLine } from './TerminalPanel.js';
import type { TerminalStatus } from './terminal-connection.js';

/*
 * xterm draws to a canvas and measures a font, neither of which jsdom has, so
 * the emulator is replaced by a stand-in that records what it was told. What
 * is under test is the panel around it: which shells exist, which one a socket
 * asks for, and what the person can do to each.
 */
const terminals = vi.hoisted(() => ({
  created: 0,
  focused: 0,
  cleared: 0,
  written: [] as string[],
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    textarea = null;
    constructor() {
      terminals.created += 1;
    }
    loadAddon(): void {}
    open(): void {}
    attachCustomKeyEventHandler(): void {}
    onData(): void {}
    onResize(): void {}
    write(text: string): void {
      terminals.written.push(text);
    }
    focus(): void {
      terminals.focused += 1;
    }
    clear(): void {
      terminals.cleared += 1;
    }
    dispose(): void {}
    hasSelection(): boolean {
      return false;
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    findNext(): boolean {
      return true;
    }
    findPrevious(): boolean {
      return true;
    }
    clearDecorations(): void {}
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

/**
 * What the console says when there is no terminal to show.
 *
 * Only the states without a live terminal are covered here. xterm draws to a
 * canvas and measures a font, neither of which jsdom has, so the working
 * terminal is exercised in a real browser instead of approximated in one that
 * cannot render it.
 */

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

const state = (status?: RuntimeStatus): RuntimeStateResponse =>
  ({
    runtime: status
      ? {
          id: 'r1',
          projectId: PROJECT,
          status,
          language: 'node',
          version: '22',
          image: 'node:22',
          limits: { cpuMillicores: 1000, memoryMb: 1024, pidsLimit: 256 },
          message: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          statusChangedAt: '2026-01-01T00:00:00.000Z',
          startedAt: null,
          stoppedAt: null,
        }
      : null,
    detected: null,
    provider: { name: 'docker', available: true, reason: null },
  }) as RuntimeStateResponse;

const panel = (props: Partial<Parameters<typeof TerminalPanel>[0]> = {}) =>
  render(<TerminalPanel projectId={PROJECT} runtime={state()} canAttach={true} {...props} />);

describe('with nothing running', () => {
  it('says so, rather than showing an empty black rectangle', () => {
    // An empty terminal and a terminal that does not exist look identical, and
    // one of them takes typing.
    panel({ runtime: state() });
    expect(screen.getByText('Nothing is running')).toBeInTheDocument();
  });

  it('says where a command would run, before anyone runs one', () => {
    panel({ runtime: state() });
    expect(screen.getByText(/Commands run in the environment/)).toBeInTheDocument();
    expect(screen.getByText(/never on the platform/)).toBeInTheDocument();
  });

  it('points at Start rather than offering a second one', async () => {
    const focusStart = vi.fn();
    render(
      <WorkspaceActionsContext.Provider value={{ ...NO_WORKSPACE_ACTIONS, focusStart }}>
        <TerminalPanel projectId={PROJECT} runtime={state()} canAttach={true} />
      </WorkspaceActionsContext.Provider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Show me' }));
    expect(focusStart).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /start/i })).not.toBeInTheDocument();
  });

  it('says the same while the runtime is still starting, and that it is coming', () => {
    // Attaching to a container that is not up yet fails in a way nobody can
    // act on. Waiting is the honest state.
    panel({ runtime: state('STARTING') });
    expect(screen.getByText('Nothing is running')).toBeInTheDocument();
    expect(screen.getByText(/A shell opens here as soon as it is running/)).toBeInTheDocument();
  });

  it('says the same for a runtime that failed', () => {
    panel({ runtime: state('FAILED') });
    expect(screen.getByText('Nothing is running')).toBeInTheDocument();
  });

  it('says the same before the runtime state has arrived', () => {
    panel({ runtime: undefined });
    expect(screen.getByText('Nothing is running')).toBeInTheDocument();
  });
});

describe('without permission', () => {
  it('offers no terminal to someone with read-only access', () => {
    // The server refuses the socket too. This is so the person is told why,
    // rather than watching a connection fail.
    panel({ runtime: state('RUNNING'), canAttach: false });

    expect(screen.getByText('No terminal')).toBeInTheDocument();
    expect(screen.getByText(/read-only access/)).toBeInTheDocument();
  });

  it('says nothing about running, because that is not the obstacle', () => {
    panel({ runtime: state('RUNNING'), canAttach: false });
    expect(screen.queryByText('Nothing is running')).not.toBeInTheDocument();
  });
});

/**
 * The line under the terminal.
 *
 * Exercised directly rather than through the panel, because reaching it that
 * way needs xterm, which needs a canvas and a font that jsdom does not have.
 * What it says is a rule, not a rendering detail: two of these sentences are
 * the only way a person learns something they could not otherwise know.
 */
describe('the status line', () => {
  const line = (status: TerminalStatus, noteDismissed = false) =>
    render(
      <TerminalStatusLine
        status={status}
        noteDismissed={noteDismissed}
        onDismissNote={() => undefined}
        onReconnect={() => undefined}
        onStartFresh={() => undefined}
      />,
    );

  const ready = (over: Partial<Extract<TerminalStatus, { state: 'ready' }>> = {}) =>
    ({ state: 'ready', sessionId: 's1', resumed: false, truncated: false, ...over }) as const;

  it('says nothing about a shell that just opened', () => {
    // A fresh prompt showing everything it has printed needs no commentary,
    // and a working shell needs no line under it at all.
    const { container } = line(ready());
    expect(container).toBeEmptyDOMElement();
  });

  it('says a shell was reattached, so it is not mistaken for a fresh one', () => {
    line(ready({ resumed: true }));
    expect(screen.getByText(/Reattached to the terminal you already had open/)).toBeInTheDocument();
  });

  it('says when the screen above it is not everything the shell printed', () => {
    // A partial screen presented as a whole one is how someone concludes a
    // command printed nothing.
    line(ready({ resumed: true, truncated: true }));
    expect(screen.getByText(/Some earlier output was dropped/)).toBeInTheDocument();
  });

  it('warns about dropped output even on a shell it did not resume', () => {
    line(ready({ resumed: false, truncated: true }));
    expect(screen.getByText(/Some earlier output was dropped/)).toBeInTheDocument();
  });

  it('floats the note over the screen rather than taking a row from it', () => {
    line(ready({ resumed: true }));
    expect(screen.getByRole('status')).toHaveClass('term-panel__status--note');
  });

  it('keeps a broken connection on a row of its own, never over the output', () => {
    line({ state: 'closed' });
    expect(screen.getByRole('status')).not.toHaveClass('term-panel__status--note');
  });

  it('goes away once the note has been dismissed', () => {
    line(ready({ resumed: true }), true);
    expect(screen.queryByText(/Reattached/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  it('offers no reconnect on a working terminal, because there is nothing to fix', () => {
    line(ready({ resumed: true }));
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });

  it('names the code a shell exited with, rather than just saying it ended', () => {
    line({ state: 'ended', code: 127 });
    expect(screen.getByText(/exited with code 127/)).toBeInTheDocument();
  });

  it('offers a way to throw a broken shell away and start another', () => {
    // Needed precisely because closing the panel no longer ends anything.
    // "New terminal" now really opens another one; this one restarts.
    line({ state: 'closed' });
    expect(screen.getByRole('button', { name: 'Restart shell' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New terminal' })).not.toBeInTheDocument();
  });

  it('offers nothing to press while it is still connecting', () => {
    line({ state: 'connecting' });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the reason a connection was refused, in words', () => {
    line({ state: 'failed', message: 'That terminal is no longer open.' });
    expect(screen.getByText('That terminal is no longer open.')).toBeInTheDocument();
  });
});

/** A socket that records where it was pointed and can be told what the server said. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.closed = true;
  }
  ready(sessionId: string, resumed = false): void {
    this.onmessage?.({
      data: JSON.stringify({ type: 'ready', sessionId, resumed, truncated: false }),
    } as MessageEvent<string>);
  }
}

describe('several shells', () => {
  const session = (id: string, lastActiveAt: string) => ({
    id,
    createdAt: lastActiveAt,
    lastActiveAt,
    attached: false,
    size: { rows: 24, columns: 80 },
  });
  const SESSION_A = '018f0000-0000-7000-8000-00000000000a';
  const SESSION_B = '018f0000-0000-7000-8000-00000000000b';

  let calls: string[];
  const serve = (sessions: ReturnType<typeof session>[]) => {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
        return Promise.resolve(
          new Response(JSON.stringify({ sessions }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
  };

  beforeEach(() => {
    FakeSocket.instances = [];
    terminals.created = 0;
    terminals.focused = 0;
    terminals.written = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('opens a shell when there are none, and says where it is', async () => {
    serve([]);
    panel({ runtime: state('RUNNING'), projectName: 'Hello World' });

    expect(await screen.findByRole('tab', { name: 'Shell 1' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    expect(FakeSocket.instances[0]?.url).not.toContain('session=');

    act(() => FakeSocket.instances[0]?.ready(SESSION_A));
    expect(terminals.written.join('')).toContain('Hello World · Node.js 22 · /workspace');
  });

  it('puts the shells’ tabs where the console asks, so they take no row of the screen', async () => {
    serve([]);
    const slot = document.createElement('div');
    document.body.append(slot);
    const view = panel({ runtime: state('RUNNING'), tabsSlot: slot });

    const tab = await screen.findByRole('tab', { name: 'Shell 1' });
    expect(slot).toContainElement(tab);
    expect(slot).toContainElement(screen.getByRole('button', { name: 'New terminal' }));
    // The screen it controls stays in the panel.
    expect(view.container).toContainElement(
      document.getElementById(tab.getAttribute('aria-controls')!),
    );
    slot.remove();
  });

  it('comes back to the shells the server says exist, on the one used last', async () => {
    serve([
      session(SESSION_B, '2026-01-01T00:05:00.000Z'),
      session(SESSION_A, '2026-01-01T00:01:00.000Z'),
    ]);
    panel({ runtime: state('RUNNING') });

    expect(await screen.findByRole('tab', { name: 'Shell 1' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.getByRole('tab', { name: 'Shell 2' })).toHaveAttribute('aria-selected', 'true');
    // Only the shell on screen is attached; the other waits until it is chosen.
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    expect(FakeSocket.instances[0]?.url).toContain(`session=${SESSION_B}`);
  });

  it('opens another shell beside the first, rather than replacing it', async () => {
    serve([]);
    panel({ runtime: state('RUNNING') });
    await screen.findByRole('tab', { name: 'Shell 1' });
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    act(() => FakeSocket.instances[0]?.ready(SESSION_A));

    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }));

    expect(screen.getByRole('tab', { name: 'Shell 2' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    expect(FakeSocket.instances[1]?.url).not.toContain('session=');
    // The first is still open.
    expect(FakeSocket.instances[0]?.closed).toBe(false);
  });

  it('stops at the five the platform allows, and says so', async () => {
    serve([]);
    panel({ runtime: state('RUNNING') });
    await screen.findByRole('tab', { name: 'Shell 1' });

    for (let i = 0; i < 4; i += 1) {
      await userEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    }

    expect(screen.getAllByRole('tab', { name: /^Shell \d$/ })).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'New terminal' })).toBeDisabled();
    expect(screen.getByText('Up to 5 shells per project')).toBeInTheDocument();
  });

  it('ends a shell when its tab is closed', async () => {
    serve([session(SESSION_A, '2026-01-01T00:01:00.000Z')]);
    panel({ runtime: state('RUNNING') });
    await screen.findByRole('tab', { name: 'Shell 1' });

    await userEvent.click(screen.getByRole('button', { name: 'Close Shell 1' }));

    await waitFor(() =>
      expect(calls).toContain(`DELETE /api/projects/${PROJECT}/runtime/terminals/${SESSION_A}`),
    );
    expect(screen.getByText('No shell open.')).toBeInTheDocument();
  });

  it('reconnects to the same shell it was on, never to whichever is listed first', async () => {
    serve([]);
    panel({ runtime: state('RUNNING') });
    await screen.findByRole('tab', { name: 'Shell 1' });
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    act(() => {
      FakeSocket.instances[0]?.ready(SESSION_A);
      FakeSocket.instances[0]?.onerror?.();
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));

    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    expect(FakeSocket.instances[1]?.url).toContain(`session=${SESSION_A}`);
  });

  it('focuses the shell when asked to', async () => {
    serve([]);
    const view = panel({ runtime: state('RUNNING'), focusRequest: 0 });
    await screen.findByRole('tab', { name: 'Shell 1' });
    await waitFor(() => expect(terminals.created).toBe(1));
    const before = terminals.focused;

    view.rerender(
      <TerminalPanel
        projectId={PROJECT}
        runtime={state('RUNNING')}
        canAttach={true}
        focusRequest={1}
      />,
    );

    await waitFor(() => expect(terminals.focused).toBeGreaterThan(before));
  });
});
