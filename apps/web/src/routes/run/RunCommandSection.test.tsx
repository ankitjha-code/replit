import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunCommandSection } from './RunCommandSection.js';

/**
 * The run command in settings. It edits the same value the console does,
 * through the same endpoint, and locks while the app is running for the same
 * reason the console does: a change then would describe the next run, not the
 * one on screen.
 */

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const runState = (overrides: Record<string, unknown> = {}) => ({
  status: 'IDLE',
  command: null,
  configuredCommand: null,
  suggestion: { command: 'node index.js', reason: 'index.js' },
  startedAt: null,
  exitedAt: null,
  exitCode: null,
  message: null,
  blockedReason: null,
  ...overrides,
});

function mockApi(state: Record<string, unknown> = {}, putStatus = 200, putBody?: unknown) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  let current = runState(state);
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body
        ? (JSON.parse(String(init.body)) as { command: string | null })
        : undefined;
      calls.push({ method, url: String(input), body });
      if (method === 'PUT') {
        if (putStatus !== 200) return Promise.resolve(json(putBody, putStatus));
        current = runState({ ...state, configuredCommand: body?.command ?? null });
        return Promise.resolve(json(current));
      }
      return Promise.resolve(json(current));
    }),
  );
  return { calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('the run command section', () => {
  it('shows the suggestion and where it came from when nothing is set', async () => {
    mockApi();
    render(<RunCommandSection projectId={PROJECT} canControl />);

    const field = await screen.findByRole('textbox', { name: 'Run command' });
    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('placeholder', 'node index.js');
    expect(screen.getByText(/Suggested by the platform, from index\.js/)).toBeInTheDocument();
    // Nothing to save yet, and the button says so rather than being a dead end.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText('Nothing has changed yet')).toBeInTheDocument();
  });

  it('saves what was typed through the console endpoint', async () => {
    const { calls } = mockApi();
    render(<RunCommandSection projectId={PROJECT} canControl />);

    await userEvent.type(await screen.findByRole('textbox', { name: 'Run command' }), 'npm start');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toContain('/runtime/run/command');
    expect(put?.body).toEqual({ command: 'npm start' });
    expect(await screen.findByText(/Set for this project/)).toBeInTheDocument();
  });

  it('goes back to the suggestion when asked', async () => {
    const { calls } = mockApi({ configuredCommand: 'npm start' });
    render(<RunCommandSection projectId={PROJECT} canControl />);

    expect(await screen.findByRole('textbox', { name: 'Run command' })).toHaveValue('npm start');
    await userEvent.click(screen.getByRole('button', { name: 'Use the suggestion' }));

    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ command: null });
    });
  });

  it('shows the server refusal against the field', async () => {
    mockApi({}, 422, {
      error: { code: 'VALIDATION_FAILED', message: 'A command cannot contain control characters' },
    });
    render(<RunCommandSection projectId={PROJECT} canControl />);

    await userEvent.type(await screen.findByRole('textbox', { name: 'Run command' }), 'bad');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('control characters');
  });

  it('locks while the app is running, and says why', async () => {
    mockApi({ status: 'RUNNING', command: 'node index.js' });
    render(<RunCommandSection projectId={PROJECT} canControl />);

    expect(await screen.findByRole('textbox', { name: 'Run command' })).toBeDisabled();
    expect(screen.getAllByText('Stop the app before changing what it runs').length).toBeGreaterThan(
      0,
    );
  });

  it('is read-only for someone who cannot control the project', async () => {
    mockApi();
    render(<RunCommandSection projectId={PROJECT} canControl={false} />);

    expect(await screen.findByRole('textbox', { name: 'Run command' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('shows the failure with a retry when the state cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(json({ error: { code: 'INTERNAL_ERROR', message: 'No runtime' } }, 500)),
      ),
    );
    render(<RunCommandSection projectId={PROJECT} canControl />);

    expect(await screen.findByText('No runtime')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
