import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeStateResponse, RuntimeStatus } from '@platform/shared';
import { useRuntime } from '../use-runtime.js';
import { EnvironmentControl, STILL_STARTING_MESSAGE } from './EnvironmentControl.js';

/**
 * The Environment half of the run strip (design spec 9.2): the chip is plain
 * text, the caret opens the details with the runtime's history, and a long
 * start says so. The state words themselves are covered in
 * RuntimeControls.test.tsx.
 */

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function runtimeRow(status: RuntimeStatus, overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    projectId: PROJECT,
    status,
    language: 'node',
    version: '22',
    image: 'node:22-bookworm-slim',
    limits: { cpuMillicores: 1000, memoryMb: 1024, pidsLimit: 256 },
    message: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    statusChangedAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    stoppedAt: null,
    ...overrides,
  };
}

const state = (runtime: unknown = null): RuntimeStateResponse =>
  ({
    runtime,
    detected: { language: 'node', version: '22', image: 'node:22', evidence: 'package.json' },
    provider: { name: 'recording', available: true, reason: null },
  }) as RuntimeStateResponse;

function mockServer(handlers: Record<string, () => Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const key = Object.keys(handlers).find((k) => url.endsWith(k));
      if (!key) throw new Error(`unexpected request to ${url}`);
      return Promise.resolve(handlers[key]!());
    }),
  );
}

function Harness({ appRunning = false }: { appRunning?: boolean }): React.JSX.Element {
  const runtime = useRuntime(PROJECT);
  return (
    <EnvironmentControl runtime={runtime} canControl projectId={PROJECT} appRunning={appRunning} />
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('EnvironmentControl', () => {
  it('keeps the chip as plain text and opens the details from the caret', async () => {
    mockServer({
      '/runtime': () =>
        json(state(runtimeRow('RUNNING', { startedAt: '2026-01-01T00:00:00.000Z' }))),
      '/runtime/events': () =>
        json({
          events: [
            {
              id: 'e2',
              from: 'STARTING',
              to: 'RUNNING',
              reason: null,
              at: '2026-01-01T00:00:05.000Z',
            },
            {
              id: 'e1',
              from: null,
              to: 'STARTING',
              reason: 'Requested by ada',
              at: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
    });
    render(<Harness />);

    const chip = await screen.findByText('Running');
    expect(chip.closest('.runtime-chip')).not.toBeNull();
    expect(chip.closest('button')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Environment details' }));
    const popover = await screen.findByRole('dialog', { name: 'Environment details' });
    expect(within(popover).getByText('Node.js 22')).toBeInTheDocument();
    expect(within(popover).getByText('node:22-bookworm-slim')).toBeInTheDocument();
    expect(within(popover).getByText('1 CPU, 1024 MB, 256 processes')).toBeInTheDocument();

    const history = await within(popover).findByRole('region', { name: 'Recent history' });
    expect(within(history).getByText('Requested by ada')).toBeInTheDocument();
    expect(within(history).getAllByRole('listitem')).toHaveLength(2);
  });

  it('says a start is still going once it has taken long enough', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockServer({
      '/runtime': () => json(state(runtimeRow('STARTING', { message: 'Pulling image' }))),
    });
    render(<Harness />);

    expect(await screen.findByText('Starting…')).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(STILL_STARTING_MESSAGE))).not.toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(21_000);
    expect(screen.getByText(new RegExp(STILL_STARTING_MESSAGE))).toBeInTheDocument();
  });

  it('asks before stopping an environment whose app is running', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.endsWith('/runtime/stop')) {
          return Promise.resolve(json(state(runtimeRow('STOPPING'))));
        }
        return Promise.resolve(json(state(runtimeRow('RUNNING'))));
      }),
    );
    render(<Harness appRunning />);

    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Stop the environment?' });
    expect(calls.filter((call) => call.startsWith('POST'))).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop environment' }));
    await waitFor(() => expect(calls.some((call) => call.endsWith('/runtime/stop'))).toBe(true));
  });

  it('reports a first read that failed, with a way to try again', async () => {
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new TypeError('network down'));
        return Promise.resolve(json(state()));
      }),
    );
    render(<Harness />);

    expect(await screen.findByText('Could not read the environment state.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Not running')).toBeInTheDocument();
  });
});
