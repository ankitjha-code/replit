import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectSecrets } from './ProjectSecrets.js';

/**
 * The secrets surface.
 *
 * Everything here is about a value that goes in and never comes out. The
 * assertions are mostly negative for that reason: what matters is what the
 * page cannot show and what it does not keep.
 */

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const secret = (key: string, length = 12) => ({
  key,
  length,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
});

const noRuntime = {
  runtime: null,
  detected: null,
  provider: { name: 'none', available: false, reason: 'No execution backend.' },
};

function mockApi(
  options: {
    secrets?: unknown[];
    unavailableReason?: string | null;
    putStatus?: number;
    putBody?: unknown;
  } = {},
) {
  const calls: { method: string; url: string; body: unknown }[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });

      if (url.includes('/runtime')) return Promise.resolve(json(noRuntime));
      if (method === 'PUT') {
        return Promise.resolve(
          json(options.putBody ?? { secret: secret('API_TOKEN') }, options.putStatus ?? 200),
        );
      }
      if (method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));

      return Promise.resolve(
        json({
          secrets: options.secrets ?? [],
          unavailableReason: options.unavailableReason ?? null,
          limit: 100,
        }),
      );
    }),
  );

  return { calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('what the page shows', () => {
  it('lists the names of secrets that are set', async () => {
    mockApi({ secrets: [secret('API_TOKEN'), secret('DATABASE_URL')] });
    render(<ProjectSecrets projectId={PROJECT} />);

    expect(await screen.findByText('API_TOKEN')).toBeInTheDocument();
    expect(screen.getByText('DATABASE_URL')).toBeInTheDocument();
    expect(screen.getByText('2 of 100')).toBeInTheDocument();
  });

  it('says plainly that values cannot be read back', async () => {
    // A field that looks like it holds a value invites someone to look for a
    // way to see it.
    mockApi();
    render(<ProjectSecrets projectId={PROJECT} />);

    expect(await screen.findByText(/cannot be read back/)).toBeInTheDocument();
  });

  it('says nothing about a value beyond it being set', async () => {
    mockApi({ secrets: [secret('API_TOKEN', 24)] });
    render(<ProjectSecrets projectId={PROJECT} />);
    await screen.findByText('API_TOKEN');

    // Not the length, which would narrow a guess.
    expect(screen.queryByText('24')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Value is hidden')).toBeInTheDocument();
    expect(screen.getByLabelText('Value is hidden')).toHaveTextContent('');
  });

  it('keeps each secret in a real list item', async () => {
    mockApi({ secrets: [secret('API_TOKEN')] });
    render(<ProjectSecrets projectId={PROJECT} />);

    const item = await screen.findByRole('listitem');
    expect(within(item).getByText('API_TOKEN')).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Remove API_TOKEN' })).toBeInTheDocument();
  });

  it('says so when the platform cannot store secrets at all', async () => {
    mockApi({ unavailableReason: 'This installation has no encryption key configured.' });
    render(<ProjectSecrets projectId={PROJECT} />);

    const note = await screen.findByText(/no encryption key/);
    // Informational, not an error: nothing went wrong.
    expect(note.closest('[role="status"]')).not.toBeNull();
    // No form, because there is nothing it could do.
    expect(screen.queryByLabelText('Value')).not.toBeInTheDocument();
  });

  it('shows the failure with a retry when the list cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          json({ error: { code: 'INTERNAL_ERROR', message: 'Storage is unavailable' } }, 500),
        ),
      ),
    );
    render(<ProjectSecrets projectId={PROJECT} />);
    expect(await screen.findByText('Storage is unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('setting one', () => {
  it('sends the name and the value', async () => {
    const { calls } = mockApi();
    render(<ProjectSecrets projectId={PROJECT} />);
    await screen.findByText('No secrets yet.');

    await userEvent.type(screen.getByLabelText('Name'), 'API_TOKEN');
    await userEvent.type(screen.getByLabelText('Value'), 'sk-live-abc');
    await userEvent.click(screen.getByRole('button', { name: 'Save secret' }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
        key: 'API_TOKEN',
        value: 'sk-live-abc',
      });
    });
  });

  it('does not keep the value in the page afterwards', async () => {
    mockApi();
    render(<ProjectSecrets projectId={PROJECT} />);
    await screen.findByText('No secrets yet.');

    await userEvent.type(screen.getByLabelText('Name'), 'API_TOKEN');
    const value = screen.getByLabelText('Value');
    await userEvent.type(value, 'sk-live-abc');
    await userEvent.click(screen.getByRole('button', { name: 'Save secret' }));

    // Sent and cleared. There is no reason for it to stay.
    await waitFor(() => expect(value).toHaveValue(''));
  });

  it('reminds that the running app only sees the change after a restart', async () => {
    mockApi();
    render(<ProjectSecrets projectId={PROJECT} />);
    await screen.findByText('No secrets yet.');
    expect(screen.queryByText(/Restart it for changes here/)).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Name'), 'API_TOKEN');
    await userEvent.type(screen.getByLabelText('Value'), 'sk-live-abc');
    await userEvent.click(screen.getByRole('button', { name: 'Save secret' }));

    expect(await screen.findByText(/Restart it for changes here/)).toBeInTheDocument();
  });

  it('never shows the value while it is being typed', async () => {
    mockApi();
    render(<ProjectSecrets projectId={PROJECT} />);
    await screen.findByText('No secrets yet.');

    expect(screen.getByLabelText('Value')).toHaveAttribute('type', 'password');
  });

  it('can reveal what is being typed, and only that', async () => {
    mockApi();
    render(<ProjectSecrets projectId={PROJECT} />);
    await screen.findByText('No secrets yet.');

    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(screen.getByLabelText('Value')).toHaveAttribute('type', 'text');
    await userEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(screen.getByLabelText('Value')).toHaveAttribute('type', 'password');
  });

  it('keeps a browser from storing it as a password', async () => {
    // A project's credential is not this platform's credential and does not
    // belong in a password manager entry for it.
    mockApi();
    render(<ProjectSecrets projectId={PROJECT} />);
    await screen.findByText('No secrets yet.');

    expect(screen.getByLabelText('Value')).toHaveAttribute('autocomplete', 'off');
  });

  it('shows the field reason rather than the general one', async () => {
    // The server says which rule the name broke. The top-level message only
    // says a name cannot be used, which tells someone nothing to change.
    mockApi({
      putStatus: 422,
      putBody: {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'That name cannot be used',
          requestId: 'r',
          details: {
            fields: [{ path: 'key', message: 'That name is reserved by the platform' }],
          },
        },
      },
    });

    render(<ProjectSecrets projectId={PROJECT} />);
    await screen.findByText('No secrets yet.');

    await userEvent.type(screen.getByLabelText('Name'), 'PATH');
    await userEvent.type(screen.getByLabelText('Value'), '/tmp');
    await userEvent.click(screen.getByRole('button', { name: 'Save secret' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('reserved by the platform');
  });

  it('shows the server refusal in its own words', async () => {
    mockApi({
      putStatus: 422,
      putBody: {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'That name is reserved by the platform',
          requestId: 'r',
        },
      },
    });

    render(<ProjectSecrets projectId={PROJECT} />);
    await screen.findByText('No secrets yet.');

    await userEvent.type(screen.getByLabelText('Name'), 'PATH');
    await userEvent.type(screen.getByLabelText('Value'), '/tmp');
    await userEvent.click(screen.getByRole('button', { name: 'Save secret' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('reserved by the platform');
  });
});

describe('removing one', () => {
  it('asks the server to remove it by name, once confirmed', async () => {
    const { calls } = mockApi({ secrets: [secret('API_TOKEN')] });
    render(<ProjectSecrets projectId={PROJECT} />);
    await screen.findByText('API_TOKEN');

    await userEvent.click(screen.getByRole('button', { name: 'Remove API_TOKEN' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove API_TOKEN?' });
    // An unrecoverable value deserves a second look.
    expect(within(dialog).getByText(/cannot be recovered/)).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove API_TOKEN' }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
    });
    expect(calls.find((call) => call.method === 'DELETE')?.url).toContain('/secrets/API_TOKEN');
  });

  it('does nothing when the removal is cancelled', async () => {
    const { calls } = mockApi({ secrets: [secret('API_TOKEN')] });
    render(<ProjectSecrets projectId={PROJECT} />);
    await screen.findByText('API_TOKEN');

    await userEvent.click(screen.getByRole('button', { name: 'Remove API_TOKEN' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });
});
