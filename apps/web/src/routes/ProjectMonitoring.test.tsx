import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiProvider, clearToasts } from '../ui/index.js';
import { ProjectMonitoring } from './ProjectMonitoring.js';

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const usage = (overrides: Record<string, unknown> = {}) => ({
  cpuMillicores: 250,
  cpuLimitMillicores: 1000,
  memoryBytes: 256 * 1024 * 1024,
  memoryLimitBytes: 512 * 1024 * 1024,
  pids: 12,
  pidsLimit: 256,
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const workload = (overrides: Record<string, unknown> = {}) => ({
  kind: 'RUNTIME',
  id: 'rt-1',
  label: 'node 20',
  usage: usage(),
  history: [usage()],
  health: { state: 'healthy', statusCode: 200, latencyMs: 12, checkedAt: null, message: null },
  ...overrides,
});

const response = (overrides: Record<string, unknown> = {}) => ({
  workloads: [],
  healthCheck: { path: '/', timeoutMs: 5000 },
  unavailableReason: null,
  historySeconds: 600,
  sampleIntervalSeconds: 5,
  ...overrides,
});

function mockApi(initial = response()) {
  const puts: unknown[] = [];
  let gets = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        puts.push(body);
        return Promise.resolve(json({ path: body.path, timeoutMs: body.timeoutMs ?? 5000 }));
      }
      gets += 1;
      return Promise.resolve(json(initial));
    }),
  );
  return { puts, gets: () => gets };
}

const renderMonitoring = (canControl = true) =>
  render(
    <MemoryRouter>
      <UiProvider>
        <ProjectMonitoring projectId={PROJECT} canControl={canControl} />
      </UiProvider>
    </MemoryRouter>,
  );

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  });
});

describe('monitoring', () => {
  it('shows each measurement as a share of its limit, with a meter and a trend', async () => {
    mockApi(response({ workloads: [workload()] }));
    renderMonitoring();

    const environment = await screen.findByRole('article', { name: 'Environment node 20' });
    expect(within(environment).getByText('25%')).toBeInTheDocument();
    expect(within(environment).getByText('50%')).toBeInTheDocument();
    expect(within(environment).getByRole('meter', { name: 'Processor' })).toHaveAttribute(
      'aria-valuetext',
      '250 of 1000 millicores',
    );
    expect(within(environment).getByRole('meter', { name: 'Memory' })).toHaveAttribute(
      'aria-valuetext',
      '256 MB of 512 MB',
    );
    expect(within(environment).getByText('Answering in 12ms')).toBeInTheDocument();
    expect(within(environment).getByText(/collecting readings/)).toBeInTheDocument();
  });

  it('keeps measuring at the sample interval while the tab is on screen, and not while it is hidden', async () => {
    vi.useFakeTimers();
    const { gets } = mockApi(response({ workloads: [workload()], sampleIntervalSeconds: 5 }));
    renderMonitoring();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(gets()).toBe(1);
    expect(screen.getByRole('switch', { name: /Keep measuring/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(gets()).toBe(2);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    const hiddenAt = gets();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(gets()).toBe(hiddenAt);
  });

  it('never draws a bar for a reading that failed', async () => {
    mockApi(
      response({
        workloads: [workload({ usage: usage({ memoryBytes: null }), history: [] })],
      }),
    );
    renderMonitoring();

    await screen.findByRole('article', { name: 'Environment node 20' });
    expect(screen.getByText('Not measured')).toBeInTheDocument();
    expect(screen.queryByRole('meter', { name: 'Memory' })).toBeNull();
    expect(screen.getByRole('meter', { name: 'Processor' })).toBeInTheDocument();
  });

  it('offers the workspace when nothing runs, and hides the health form', async () => {
    mockApi();
    renderMonitoring();

    expect(await screen.findByText('Nothing to measure.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open workspace' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT}`,
    );
    expect(screen.queryByLabelText('Health check path')).toBeNull();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeEnabled();
  });

  it('says calmly when this installation cannot measure anything', async () => {
    mockApi(response({ unavailableReason: 'No execution backend is configured.' }));
    renderMonitoring();

    const note = await screen.findByText('No execution backend is configured.');
    expect(note.closest('[role="status"]')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('saves the health check path and timeout together', async () => {
    const { puts } = mockApi(response({ workloads: [workload()] }));
    renderMonitoring();

    const path = await screen.findByLabelText('Health check path');
    const save = screen.getByRole('button', { name: 'Save check' });
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription('Nothing has changed yet');

    await userEvent.clear(path);
    await userEvent.type(path, '/healthz');
    const timeout = screen.getByLabelText('Timeout');
    await userEvent.clear(timeout);
    await userEvent.type(timeout, '2000');
    await userEvent.click(screen.getByRole('button', { name: 'Save check' }));

    await waitFor(() => expect(puts).toEqual([{ path: '/healthz', timeoutMs: 2000 }]));
    expect(await screen.findByText('Health check saved')).toBeInTheDocument();
  });

  it('puts a rejected path against its field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve(
          init?.method === 'PUT'
            ? json(
                {
                  error: {
                    code: 'VALIDATION_FAILED',
                    message: 'Invalid',
                    details: { fields: [{ path: 'path', message: 'A path starts with a slash' }] },
                  },
                },
                400,
              )
            : json(response({ workloads: [workload()] })),
        ),
      ),
    );
    renderMonitoring();

    const path = await screen.findByLabelText('Health check path');
    await userEvent.clear(path);
    await userEvent.type(path, 'healthz');
    await userEvent.click(screen.getByRole('button', { name: 'Save check' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('A path starts with a slash');
    expect(path).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows no form to someone who cannot control the project', async () => {
    mockApi(response({ workloads: [workload()] }));
    renderMonitoring(false);

    await screen.findByRole('article', { name: 'Environment node 20' });
    expect(screen.queryByLabelText('Health check path')).toBeNull();
  });

  it('reads again on Check now and shows the error with a retry when that fails', async () => {
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        attempts += 1;
        return Promise.resolve(
          attempts === 2
            ? json({ error: { code: 'INTERNAL', message: 'The runtime did not answer.' } }, 500)
            : json(response({ workloads: [workload()] })),
        );
      }),
    );
    renderMonitoring();

    await screen.findByRole('article', { name: 'Environment node 20' });
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The runtime did not answer.');
    expect(screen.getByRole('article', { name: 'Environment node 20' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(attempts).toBe(3);
  });
});
