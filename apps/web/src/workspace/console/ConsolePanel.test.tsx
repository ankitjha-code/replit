import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeStateResponse, RunStatus } from '@platform/shared';
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
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
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

afterEach(() => vi.unstubAllGlobals());

const panel = (props: Partial<Parameters<typeof ConsolePanel>[0]> = {}) =>
  render(
    <ConsolePanel
      projectId={PROJECT}
      runtime={runtimeState('RUNNING')}
      canControl={true}
      {...props}
    />,
  );

describe('what the output tab says when there is nothing', () => {
  it('says to start the project when no runtime is up', async () => {
    mockApi(runState({ blockedReason: 'Start the project before running it.' }));
    panel({ runtime: runtimeState() });

    expect(await screen.findByText(/Start the project before running it/)).toBeInTheDocument();
  });

  it('says nothing has run yet when it could', async () => {
    mockApi(runState());
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
