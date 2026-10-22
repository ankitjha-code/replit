import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeStateResponse, RuntimeStatus } from '@platform/shared';
import { RuntimeControls } from './RuntimeControls.js';
import { useRuntime } from './use-runtime.js';

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const detectedNode = {
  language: 'node' as const,
  version: '22',
  image: 'node:22-bookworm-slim',
  evidence: 'package.json',
};

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

const available = (
  runtime: unknown = null,
  detected: unknown = detectedNode,
): RuntimeStateResponse =>
  ({
    runtime,
    detected,
    provider: { name: 'recording', available: true, reason: null },
  }) as RuntimeStateResponse;

const unavailable = (): RuntimeStateResponse =>
  ({
    runtime: null,
    detected: detectedNode,
    provider: {
      name: 'none',
      available: false,
      reason:
        'This installation has no execution backend configured, so projects cannot be started.',
    },
  }) as RuntimeStateResponse;

interface Server {
  get: unknown;
  post?: () => Response;
}

function mockServer(server: Server) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'POST' && server.post) return Promise.resolve(server.post());
      return Promise.resolve(json(server.get));
    }),
  );
  return { calls };
}

function Harness({ canControl }: { canControl: boolean }): React.JSX.Element {
  const runtime = useRuntime(PROJECT);
  return <RuntimeControls runtime={runtime} canControl={canControl} />;
}

const renderControls = (canControl = true) => render(<Harness canControl={canControl} />);

afterEach(() => vi.unstubAllGlobals());

describe('when the platform cannot run anything', () => {
  it('says running is unavailable rather than not running', async () => {
    mockServer({ get: unavailable() });
    renderControls();

    expect(await screen.findByText('Running unavailable')).toBeInTheDocument();
  });

  it('disables the control and gives the server reason for it', async () => {
    mockServer({ get: unavailable() });
    renderControls();

    const run = await screen.findByRole('button', { name: 'Start' });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute('title', expect.stringContaining('no execution backend'));
  });

  it('never sends a start it knows will be refused', async () => {
    const { calls } = mockServer({ get: unavailable() });
    renderControls();
    await screen.findByText('Running unavailable');

    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(calls.filter((call) => call.includes('POST'))).toHaveLength(0);
  });
});

describe('when nothing has been started yet', () => {
  it('says the project is not running', async () => {
    mockServer({ get: available() });
    renderControls();
    expect(await screen.findByText('Not running')).toBeInTheDocument();
  });

  it('names the runtime it detected and the file that decided it', async () => {
    mockServer({ get: available() });
    renderControls();

    expect(await screen.findByText('Node.js 22, from package.json')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toHaveAttribute(
      'title',
      'Node.js 22, from package.json',
    );
  });

  it('asks which language when the project does not say what it is', async () => {
    const { calls } = mockServer({
      get: available(null, null),
      post: () => json(available(runtimeRow('STARTING', { language: 'python' }))),
    });
    renderControls();

    const start = await waitFor(() => {
      const button = screen.getByRole('button', { name: 'Start' });
      expect(button).toBeEnabled();
      return button;
    });
    expect(start).toHaveAttribute('title', 'Choose what this project runs.');

    await userEvent.click(start);
    const dialog = await screen.findByRole('dialog', { name: 'What does this project run?' });
    expect(dialog).toHaveTextContent('package.json');
    expect(calls.filter((call) => call.includes('POST'))).toHaveLength(0);

    await userEvent.click(screen.getByRole('radio', { name: /Python/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Start with Python' }));

    await waitFor(() =>
      expect(calls.some((call) => call.includes('POST') && call.endsWith('/runtime/start'))).toBe(
        true,
      ),
    );
    const posted = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(JSON.parse(String((posted?.[1] as RequestInit).body))).toEqual({ language: 'python' });
    expect(await screen.findByText('Starting…')).toBeInTheDocument();
  });
});

describe('starting', () => {
  it('shows running only after the server says so', async () => {
    mockServer({
      get: available(),
      post: () => json(available(runtimeRow('RUNNING'))),
    });
    renderControls();
    await screen.findByText('Not running');

    await userEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(await screen.findByText('Running')).toBeInTheDocument();
  });

  it('offers stopping once it is running', async () => {
    mockServer({ get: available(runtimeRow('RUNNING')) });
    renderControls();

    expect(await screen.findByRole('button', { name: 'Stop' })).toBeEnabled();
  });

  it('offers Stop as the cancel while the runtime is starting, never a second Start', async () => {
    const { calls } = mockServer({
      get: available(runtimeRow('STARTING', { message: 'Pulling image node:22' })),
      post: () => json(available(runtimeRow('STOPPING'))),
    });
    renderControls();

    expect(await screen.findByText('Starting…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    expect(screen.getByText(/Pulling image node:22/)).toBeInTheDocument();

    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop).toBeEnabled();
    await userEvent.click(stop);
    await waitFor(() => expect(calls.some((call) => call.endsWith('/runtime/stop'))).toBe(true));
  });

  it('shows a busy Stop while the runtime is stopping', async () => {
    mockServer({ get: available(runtimeRow('STOPPING')) });
    renderControls();

    expect(await screen.findByText('Stopping…')).toBeInTheDocument();
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop).toBeDisabled();
    expect(stop).toHaveAttribute('aria-busy', 'true');
  });

  it('reports a refusal in the server own words', async () => {
    mockServer({
      get: available(),
      post: () =>
        json(
          {
            error: {
              code: 'RUNTIME_UNAVAILABLE',
              message: 'The execution backend is not reachable.',
              requestId: 'r',
            },
          },
          503,
        ),
    });
    renderControls();
    await screen.findByText('Not running');

    await userEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The execution backend is not reachable.',
    );
  });

  it('shows a failed runtime and the reason it failed', async () => {
    mockServer({
      get: available(
        runtimeRow('FAILED', { message: 'The development environment could not be created.' }),
      ),
    });
    renderControls();

    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(
      screen.getByText('The development environment could not be created.'),
    ).toBeInTheDocument();
  });

  it('lets a failed runtime be started again', async () => {
    mockServer({ get: available(runtimeRow('FAILED', { message: 'It broke.' })) });
    renderControls();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled());
    expect(screen.getByText('It broke.')).toBeInTheDocument();
  });
});

describe('read-only access', () => {
  it('shows the state but does not offer the control', async () => {
    mockServer({ get: available(runtimeRow('RUNNING')) });
    renderControls(false);

    expect(await screen.findByText('Running')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Stop' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringContaining('read-only'));
  });
});

describe('while the state is unknown', () => {
  it('says it is checking rather than guessing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    renderControls();

    expect(screen.getByText('Checking…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
  });

  it('keeps the same Start element once the check is done', async () => {
    let answer: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      ),
    );
    renderControls();
    const before = screen.getByRole('button', { name: 'Start' });
    expect(before).toBeDisabled();

    answer(json(available(null, detectedNode)));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Start' })).toBe(before);
  });

  it('keeps the last known state when a refresh fails', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        calls += 1;
        if (calls === 1) return Promise.resolve(json(available(runtimeRow('RUNNING'))));
        return Promise.reject(new TypeError('network down'));
      }),
    );
    renderControls();
    await screen.findByText('Running');

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('Running')).toBeInTheDocument();
  });
});
