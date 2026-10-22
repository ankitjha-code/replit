import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeStateResponse, RunStatus } from '@platform/shared';
import { clearToasts } from '../../ui/index.js';
import { WORKSPACE_EVENTS } from '../shell/shortcuts.js';
import {
  NO_WORKSPACE_ACTIONS,
  WorkspaceActionsContext,
  type RunActions,
  type WorkspaceActions,
} from '../shell/workspace-actions.js';
import { ConsolePanel } from './ConsolePanel.js';

/**
 * The console.
 *
 * xterm cannot run in jsdom, so the shell tab is covered in a real browser.
 * What is checked here is the output tab: that it distinguishes the several
 * reasons there is nothing to show, and never claims more than the server did.
 */

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const runtimeState = (status?: 'RUNNING' | 'STOPPED'): RuntimeStateResponse =>
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

const runState = (overrides: Partial<Record<string, unknown>> = {}) => ({
  status: 'IDLE' as RunStatus,
  command: null,
  configuredCommand: null,
  suggestion: null,
  startedAt: null,
  exitedAt: null,
  exitCode: null,
  message: null,
  blockedReason: null,
  ...overrides,
});

/** A socket the test drives. Nothing here opens a real one. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  /** OPEN unless a test says otherwise; 0 is CONNECTING. */
  readyState = 1;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  /** Pretends the connection dropped. */
  drop(code = 1006): void {
    this.onclose?.({ code } as CloseEvent);
  }

  /** Pretends the server sent something. */
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent<string>);
  }
}

function mockApi(state: ReturnType<typeof runState>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return Promise.resolve(json(state));
    }),
  );
  return { calls };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

/** The open-logs control navigates, so the panel needs a router around it. */
const inRouter = (ui: ReactElement) => <MemoryRouter>{ui}</MemoryRouter>;

const panel = (props: Partial<Parameters<typeof ConsolePanel>[0]> = {}) => {
  const view = render(
    inRouter(
      <ConsolePanel
        projectId={PROJECT}
        runtime={runtimeState('RUNNING')}
        canControl={true}
        {...props}
      />,
    ),
  );
  return {
    ...view,
    rerender: (next: Partial<Parameters<typeof ConsolePanel>[0]> = {}) =>
      view.rerender(
        inRouter(
          <ConsolePanel
            projectId={PROJECT}
            runtime={runtimeState('RUNNING')}
            canControl={true}
            {...props}
            {...next}
          />,
        ),
      ),
  };
};

describe('what the output tab says when there is nothing', () => {
  it('says to start the project when no runtime is up', async () => {
    mockApi(runState({ blockedReason: 'Start the environment before running the app.' }));
    panel({ runtime: runtimeState() });

    expect(
      await screen.findByText(/Start the environment before running the app/),
    ).toBeInTheDocument();
  });

  it('says nothing has run yet when it could', async () => {
    mockApi(runState({ suggestion: { command: 'npm start', reason: 'x' } }));
    panel();

    expect(await screen.findByText(/Nothing has run yet/)).toBeInTheDocument();
  });

  it('says the application is running but silent', async () => {
    // Different from having printed nothing because it never started.
    mockApi(runState({ status: 'RUNNING', command: 'npm start' }));
    panel();

    expect(await screen.findByText(/Nothing has been printed yet/)).toBeInTheDocument();
  });

  it('repeats the reason the server gave for a failure', async () => {
    mockApi(runState({ status: 'FAILED', exitCode: 1, message: 'Exited with code 1.' }));
    panel();

    expect(await screen.findByText('Exited with code 1.')).toBeInTheDocument();
  });
});

describe('output', () => {
  it('shows what the server said was printed before this client connected', async () => {
    mockApi(runState({ status: 'RUNNING' }));
    panel();
    await screen.findByText(/Nothing has been printed/);

    FakeSocket.instances[0]?.receive({
      type: 'history',
      lines: [{ stream: 'stdout', data: 'listening on 3000\n', at: '2026-01-01T00:00:00.000Z' }],
      truncated: false,
    });

    expect(await screen.findByText(/listening on 3000/)).toBeInTheDocument();
  });

  it('says when earlier output was dropped', async () => {
    // A partial log presented as a whole one would have someone hunting for a
    // cause that is no longer on screen.
    mockApi(runState({ status: 'RUNNING' }));
    panel();
    await screen.findByText(/Nothing has been printed/);

    FakeSocket.instances[0]?.receive({ type: 'history', lines: [], truncated: true });

    expect(await screen.findByText(/Earlier output is no longer held/)).toBeInTheDocument();
  });

  it('marks errors apart from ordinary output', async () => {
    mockApi(runState({ status: 'RUNNING' }));
    panel();
    await screen.findByText(/Nothing has been printed/);

    FakeSocket.instances[0]?.receive({ type: 'output', stream: 'stderr', data: 'it broke\n' });

    const line = await screen.findByText(/it broke/);
    expect(line.className).toContain('stderr');
  });

  it('ignores a message the protocol does not describe', async () => {
    // This text is rendered. Arriving on an authenticated socket does not make
    // unrecognised content safe to show.
    mockApi(runState({ status: 'RUNNING' }));
    panel();
    await screen.findByText(/Nothing has been printed/);

    FakeSocket.instances[0]?.receive({ type: 'output', stream: 'stdin', data: 'nope' });
    FakeSocket.instances[0]?.receive({ type: 'eval', data: 'nope' });

    expect(screen.queryByText(/nope/)).not.toBeInTheDocument();
  });

  it('opens no socket when there is no runtime to watch', () => {
    mockApi(runState());
    panel({ runtime: runtimeState() });

    expect(FakeSocket.instances).toHaveLength(0);
  });
});

describe('the run control', () => {
  it('shows the command that would run, and where it came from', async () => {
    mockApi(
      runState({
        suggestion: { command: 'npm start', reason: 'the start script in package.json' },
      }),
    );
    panel();

    const command = await screen.findByTitle(/Suggested by the platform/);
    expect(command).toHaveTextContent('npm start');
  });

  it('starts the application', async () => {
    const { calls } = mockApi(runState({ suggestion: { command: 'npm start', reason: 'x' } }));
    panel();
    await screen.findByText('npm start');

    await userEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => {
      expect(calls.some((call) => call.includes('POST') && call.includes('/run/start'))).toBe(true);
    });
  });

  it('offers stopping while it is running', async () => {
    mockApi(runState({ status: 'RUNNING', command: 'npm start' }));
    panel();

    expect(await screen.findByRole('button', { name: 'Stop' })).toBeEnabled();
  });

  it('will not start what cannot be started, and says why', async () => {
    mockApi(
      runState({ blockedReason: 'This project does not say how to start. Set a run command.' }),
    );
    panel();

    const button = await screen.findByRole('button', { name: 'Run' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringContaining('does not say how to start'));
  });

  it('offers nothing to someone with read-only access', async () => {
    mockApi(runState());
    panel({ canControl: false });

    const button = await screen.findByRole('button', { name: 'Run' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringContaining('read-only'));
  });
});

describe('setting what the project runs', () => {
  it('offers the suggested command as a placeholder rather than as a fact', async () => {
    mockApi(runState({ suggestion: { command: 'node index.js', reason: 'index.js' } }));
    panel();
    await screen.findByText('node index.js');

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const input = screen.getByLabelText('Run command');
    // Empty, not pre-filled with the guess: a guess in the box would be saved
    // as a decision the moment anyone pressed Save.
    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('placeholder', 'node index.js');
  });

  it('saves a command the project did not have', async () => {
    const { calls } = mockApi(runState());
    panel();
    await screen.findByText('No run command');

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.type(screen.getByLabelText('Run command'), 'node server.js');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(calls.some((call) => call.includes('PUT') && call.includes('/run/command'))).toBe(
        true,
      );
    });
  });

  it('shows what was set for the project, not a guess', async () => {
    mockApi(runState({ command: 'make serve', configuredCommand: 'make serve' }));
    panel();

    expect(await screen.findByTitle(/Set for this project/)).toHaveTextContent('make serve');
  });

  it('does not offer to change it to someone with read-only access', async () => {
    mockApi(runState({ command: 'npm start' }));
    panel({ canControl: false });
    await screen.findByText('npm start');

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('will not change it under a running application', async () => {
    // The command that is running is not the command that would run, and
    // showing a new one beside a live process reads as though it changed.
    mockApi(runState({ status: 'RUNNING', command: 'npm start' }));
    panel();

    expect(await screen.findByRole('button', { name: 'Edit' })).toBeDisabled();
  });
});

describe('the two tabs', () => {
  it('opens on the output, because that is what running produces', async () => {
    mockApi(runState());
    panel();

    expect(await screen.findByRole('tab', { name: 'Output' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('offers a shell as well', async () => {
    mockApi(runState());
    panel();

    expect(await screen.findByRole('tab', { name: 'Shell' })).toBeInTheDocument();
  });
});

describe('following the runtime', () => {
  /** An API whose answer the test changes between reads. */
  function mockChangingApi(initial: ReturnType<typeof runState>) {
    let state = initial;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(state))),
    );
    return {
      serve: (next: ReturnType<typeof runState>) => {
        state = next;
      },
    };
  }

  it('offers Run once the runtime is up, without the command being saved again', async () => {
    const api = mockChangingApi(
      runState({ blockedReason: 'Start the environment before running the app.' }),
    );
    const view = panel({ runtime: runtimeState('STOPPED') });

    expect(await screen.findByRole('button', { name: 'Run' })).toBeDisabled();

    // The server's answer depends on the container, so it changes when the
    // container comes up.
    api.serve(runState({ suggestion: { command: 'npm start', reason: 'x' } }));
    view.rerender({ runtime: runtimeState('RUNNING') });

    // Queried each time: the button is re-created when its reason goes away.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled());
  });

  it('never offers Stop for a program whose environment is gone, and corrects itself', async () => {
    // The container is gone, the program with it, and the last read still
    // says Running. Stop on a corpse would be a lie; Run waits for Start.
    const api = mockChangingApi(runState({ status: 'RUNNING', command: 'sleep 600' }));
    const view = panel({ runtime: runtimeState('STOPPED') });

    expect(await screen.findByRole('button', { name: 'Run' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();

    // The project's events say what happened, and the state is read again.
    api.serve(
      runState({ status: 'EXITED', command: 'sleep 600', message: 'The runtime stopped.' }),
    );
    view.rerender({ runtime: runtimeState('STOPPED'), runStateNonce: 1 });

    expect(await screen.findByText('Stopped', { exact: true })).toBeInTheDocument();
  });
});

describe('the one lit button', () => {
  // Spec 8.5: exactly one accent-filled button at any moment. The toolbar's
  // Start holds it while the environment is down; the console's Run holds it
  // while the environment runs and the app does not; nothing while both run.
  const primaries = (container: HTMLElement) =>
    [...container.querySelectorAll('.ui-button--primary')].map((el) => el.textContent);

  it('is not in the console while the environment is stopped', async () => {
    mockApi(runState({ blockedReason: 'Start the environment before running the app.' }));
    const { container } = panel({ runtime: runtimeState('STOPPED') });
    await screen.findByText(/Start the environment before running the app/);

    expect(primaries(container)).toEqual([]);
  });

  it('is Run once the environment runs and the app does not', async () => {
    mockApi(runState({ suggestion: { command: 'npm start', reason: 'x' } }));
    const { container } = panel();
    await screen.findByText(/Nothing has run yet/);

    expect(primaries(container)).toEqual(['Run']);
  });

  it('is gone while the app runs', async () => {
    mockApi(runState({ status: 'RUNNING', command: 'npm start' }));
    const { container } = panel();
    await screen.findByRole('button', { name: 'Stop' });

    expect(primaries(container)).toEqual([]);
  });

  it('is not given to a Run that cannot be pressed', async () => {
    mockApi(runState({ blockedReason: 'This project does not say how to start.' }));
    const { container } = panel();
    await screen.findByText('No run command');

    expect(primaries(container)).toEqual([]);
  });
});

describe('what the console says in the stream', () => {
  it('says the program was stopped by the person who stopped it', async () => {
    let state = runState({ status: 'RUNNING', command: 'npm start' });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST' && String(input).includes('/run/stop')) {
          state = runState({ status: 'EXITED', command: 'npm start', exitCode: 143 });
        }
        return Promise.resolve(json(state));
      }),
    );
    panel();

    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));

    expect(await screen.findByText('Stopped by you')).toBeInTheDocument();
  });

  it('says what a program exited with, and after how long', async () => {
    let state = runState({ status: 'RUNNING', command: 'npm start' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(state))),
    );
    panel();
    await screen.findByRole('button', { name: 'Stop' });

    state = runState({
      status: 'FAILED',
      command: 'npm start',
      exitCode: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      exitedAt: '2026-01-01T00:00:12.000Z',
    });
    act(() => FakeSocket.instances[0]?.receive({ type: 'status', status: 'FAILED', exitCode: 1 }));

    expect(await screen.findByText('Exited with code 1 after 12s')).toBeInTheDocument();
    expect(screen.getByText('Exited 1', { exact: true })).toBeInTheDocument();
  });

  it('says a program ended even when it was over before the start was answered', async () => {
    let state = runState({ suggestion: { command: 'echo hi', reason: 'x' } });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST' && String(input).includes('/run/start')) {
          state = runState({ status: 'EXITED', command: 'echo hi', exitCode: 0 });
        }
        return Promise.resolve(json(state));
      }),
    );
    panel();

    await screen.findByText(/Nothing has run yet/);
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect(await screen.findByText('Exited with code 0')).toBeInTheDocument();
    expect(screen.getByText('Started echo hi')).toBeInTheDocument();
  });

  it('turns colour codes into colour rather than printing them', async () => {
    mockApi(runState({ status: 'RUNNING' }));
    panel();
    await screen.findByText(/Nothing has been printed/);

    act(() =>
      FakeSocket.instances[0]?.receive({
        type: 'output',
        stream: 'stdout',
        data: '\u001b[32mready\u001b[0m\n',
      }),
    );

    const ready = await screen.findByText('ready');
    expect(ready.className).toContain('ansi-fg-green');
    expect(screen.queryByText(/\[32m/)).not.toBeInTheDocument();
  });

  it('clears what is on screen and says where the rest is', async () => {
    mockApi(runState({ status: 'RUNNING' }));
    panel();
    await screen.findByText(/Nothing has been printed/);
    act(() =>
      FakeSocket.instances[0]?.receive({ type: 'output', stream: 'stdout', data: 'one\n' }),
    );
    await screen.findByText(/one/);

    await userEvent.click(screen.getByRole('button', { name: 'Clear output' }));

    expect(screen.queryByText(/one/)).not.toBeInTheDocument();
    expect(screen.getByText('Cleared. Earlier output is still in Logs.')).toBeInTheDocument();
  });

  it('counts what a search finds', async () => {
    mockApi(runState({ status: 'RUNNING' }));
    panel();
    await screen.findByText(/Nothing has been printed/);
    act(() =>
      FakeSocket.instances[0]?.receive({
        type: 'output',
        stream: 'stdout',
        data: 'GET / 200\nGET /x 404\n',
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Search output' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Search output' }), 'get');

    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
  });
});

describe('the output socket', () => {
  it('reconnects on its own when it drops, and says so meanwhile', async () => {
    mockApi(runState({ status: 'RUNNING', command: 'npm start' }));
    panel();
    await screen.findByText(/Nothing has been printed/);

    act(() => FakeSocket.instances[0]?.drop());

    expect(await screen.findByText('Reconnecting to output…')).toBeInTheDocument();
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2), { timeout: 2_500 });
  });

  it('stops trying when the server says access changed', async () => {
    mockApi(runState({ status: 'RUNNING', command: 'npm start' }));
    panel();
    await screen.findByText(/Nothing has been printed/);

    act(() => FakeSocket.instances[0]?.drop(1008));

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('lets a socket that is still opening finish before closing it, which is quiet', async () => {
    // Closing one mid-handshake logs "WebSocket is closed before the
    // connection is established"; React's development double-mount does that
    // on every load.
    mockApi(runState({ status: 'RUNNING' }));
    const view = panel();
    await screen.findByText(/Nothing has been printed/);
    const socket = FakeSocket.instances[0]!;
    socket.readyState = 0;

    view.unmount();
    expect(socket.closed).toBe(false);

    socket.onopen?.();
    expect(socket.closed).toBe(true);
  });
});

describe('setting what the project runs, when the save fails', () => {
  it('keeps the draft and says why inside the form', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve(
          init?.method === 'PUT'
            ? json(
                { error: { code: 'VALIDATION_FAILED', message: 'That command is too long.' } },
                400,
              )
            : json(runState()),
        ),
      ),
    );
    panel();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await userEvent.type(screen.getByLabelText('Run command'), 'node server.js');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('That command is too long.')).toBeInTheDocument();
    expect(screen.getByLabelText('Run command')).toHaveValue('node server.js');
  });

  it('opens from the empty state of a project with no run command', async () => {
    mockApi(runState());
    panel();

    await userEvent.click(await screen.findByRole('button', { name: 'Set run command' }));

    expect(screen.getByLabelText('Run command')).toHaveFocus();
  });
});

describe('the shell tab', () => {
  it('is not opened until it is asked for', async () => {
    mockApi(runState());
    panel({ runtime: runtimeState('STOPPED') });
    await screen.findByRole('tab', { name: 'Shell' });

    expect(screen.queryByText('Nothing is running')).not.toBeInTheDocument();
  });

  it('stays mounted across switches, so a shell is never reattached for nothing', async () => {
    mockApi(runState());
    panel({ runtime: runtimeState('STOPPED') });

    await userEvent.click(await screen.findByRole('tab', { name: 'Shell' }));
    const placeholder = screen.getByText('Nothing is running');
    await userEvent.click(screen.getByRole('tab', { name: 'Output' }));

    // Hidden, not gone: the same element is still there.
    expect(placeholder).toBeInTheDocument();
    expect(placeholder).not.toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'Shell' }));
    expect(screen.getByText('Nothing is running')).toBe(placeholder);
  });

  it('comes forward when the frame asks to focus the terminal', async () => {
    mockApi(runState());
    panel({ runtime: runtimeState('STOPPED') });
    await screen.findByRole('tab', { name: 'Shell' });

    act(() => {
      document.dispatchEvent(new CustomEvent(WORKSPACE_EVENTS.focusTerminal));
    });

    expect(screen.getByRole('tab', { name: 'Shell' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('the workspace frame', () => {
  function withFrame() {
    const registered: {
      actions: RunActions | null;
      select: ((tab: 'output' | 'shell') => void) | null;
      target: HTMLElement | null;
    } = { actions: null, select: null, target: null };
    const frame: WorkspaceActions = {
      ...NO_WORKSPACE_ACTIONS,
      registerRunActions: (actions) => {
        registered.actions = actions;
      },
      registerConsoleTabSelector: (select) => {
        registered.select = select;
      },
      registerRunTarget: (element) => {
        registered.target = element;
      },
    };
    const view = render(
      inRouter(
        <WorkspaceActionsContext.Provider value={frame}>
          <ConsolePanel projectId={PROJECT} runtime={runtimeState('RUNNING')} canControl={true} />
        </WorkspaceActionsContext.Provider>,
      ),
    );
    return { registered, view };
  }

  it('gives the frame Run for its shortcut and palette', async () => {
    const { calls } = mockApi(runState({ suggestion: { command: 'npm start', reason: 'x' } }));
    const { registered } = withFrame();
    await screen.findByText(/Nothing has run yet/);

    await act(async () => {
      await registered.actions?.run();
    });

    expect(calls.some((call) => call.includes('POST') && call.includes('/run/start'))).toBe(true);
  });

  it('gives the frame the Run button, so "Show me" can find it', async () => {
    mockApi(runState({ suggestion: { command: 'npm start', reason: 'x' } }));
    const { registered } = withFrame();
    await screen.findByText(/Nothing has run yet/);

    expect(registered.target).toBe(screen.getByRole('button', { name: 'Run' }));
  });

  it('lets the frame choose the tab', async () => {
    mockApi(runState());
    const { registered } = withFrame();
    await screen.findByRole('tab', { name: 'Shell' });

    act(() => registered.select?.('shell'));

    expect(screen.getByRole('tab', { name: 'Shell' })).toHaveAttribute('aria-selected', 'true');
  });

  it('takes its registrations back when it goes away', async () => {
    mockApi(runState());
    const { registered, view } = withFrame();
    await screen.findByRole('tab', { name: 'Shell' });

    view.unmount();

    expect(registered.actions).toBeNull();
    expect(registered.select).toBeNull();
    expect(registered.target).toBeNull();
  });
});

describe('searching with the keyboard', () => {
  it('opens on Ctrl/Cmd+F from inside the console', async () => {
    mockApi(runState({ status: 'RUNNING' }));
    panel();
    const tab = await screen.findByRole('tab', { name: 'Output' });

    fireEvent.keyDown(tab, { key: 'f', ctrlKey: true, metaKey: true });

    expect(screen.getByRole('textbox', { name: 'Search output' })).toBeInTheDocument();
  });
});

describe('following the files', () => {
  it('reads the suggestion again when the platform detects what the project is', async () => {
    // The suggested command comes from the same files as the detection, so a
    // new manifest changes it without anything starting.
    let state = runState({ blockedReason: 'Start the environment before running the app.' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(state))),
    );
    const view = panel({ runtime: runtimeState() });
    await screen.findByText(/Start the environment before running the app/);
    expect(screen.queryByTitle(/Suggested by the platform/)).not.toBeInTheDocument();

    state = runState({
      blockedReason: 'Start the environment before running the app.',
      suggestion: { command: 'npm start', reason: 'package.json' },
    });
    view.rerender({
      runtime: {
        ...runtimeState(),
        detected: { language: 'node', version: '22', image: 'node:22', evidence: 'package.json' },
      } as RuntimeStateResponse,
    });

    expect(await screen.findByTitle(/Suggested by the platform/)).toHaveTextContent('npm start');
  });
});
