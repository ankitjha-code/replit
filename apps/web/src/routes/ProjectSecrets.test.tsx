import { render, screen, waitFor } from '@testing-library/react';
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

function mockApi(options: { secrets?: unknown[]; unavailableReason?: string | null } = {}) {
  const calls: { method: string; body: unknown }[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

      if (method === 'PUT') return Promise.resolve(json({ secret: secret('API_TOKEN') }));
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
  });

  it('says so when the platform cannot store secrets at all', async () => {
    mockApi({ unavailableReason: 'This installation has no encryption key configured.' });
    render(<ProjectSecrets projectId={PROJECT} />);

    expect(await screen.findByText(/no encryption key/)).toBeInTheDocument();
    // No form, because there is nothing it could do.
    expect(screen.queryByLabelText('Value')).not.toBeInTheDocument();
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

  it('never shows the value while it is being typed', async () => {
    mockApi();
    render(<ProjectSecrets projectId={PROJECT} />);
    await screen.findByText('No secrets yet.');

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
    mockApi();
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'PUT') {
          return Promise.resolve(
            json(
              {
                error: {
                  code: 'VALIDATION_FAILED',
                  message: 'That name cannot be used',
                  requestId: 'r',
                  details: {
                    fields: [{ path: 'key', message: 'That name is reserved by the platform' }],
                  },
                },
              },
              422,
            ),
          );
        }
        return Promise.resolve(json({ secrets: [], unavailableReason: null, limit: 100 }));
      }),
    );

    render(<ProjectSecrets projectId={PROJECT} />);
    await screen.findByText('No secrets yet.');

    await userEvent.type(screen.getByLabelText('Name'), 'PATH');
    await userEvent.type(screen.getByLabelText('Value'), '/tmp');
    await userEvent.click(screen.getByRole('button', { name: 'Save secret' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('reserved by the platform');
  });

  it('shows the server refusal in its own words', async () => {
    mockApi();
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'PUT') {
          return Promise.resolve(
            json(
              {
                error: {
                  code: 'VALIDATION_FAILED',
                  message: 'That name is reserved by the platform',
                  requestId: 'r',
                },
              },
              422,
            ),
          );
        }
        return Promise.resolve(json({ secrets: [], unavailableReason: null, limit: 100 }));
      }),
    );

    render(<ProjectSecrets projectId={PROJECT} />);
    await screen.findByText('No secrets yet.');

    await userEvent.type(screen.getByLabelText('Name'), 'PATH');
    await userEvent.type(screen.getByLabelText('Value'), '/tmp');
    await userEvent.click(screen.getByRole('button', { name: 'Save secret' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('reserved by the platform');
  });
});

describe('removing one', () => {
  it('asks the server to remove it by name', async () => {
    const { calls } = mockApi({ secrets: [secret('API_TOKEN')] });
    render(<ProjectSecrets projectId={PROJECT} />);
    await screen.findByText('API_TOKEN');

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
    });
  });
});
