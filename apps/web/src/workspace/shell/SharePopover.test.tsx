import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharePopover } from './SharePopover.js';

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function mockApi(handlers: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const key = Object.keys(handlers).find((k) => call.url.includes(k));
      if (!key) throw new Error(`unexpected ${call.method} ${call.url}`);
      return Promise.resolve(handlers[key]!(call));
    }),
  );
  return calls;
}

const share = (overrides: Record<string, unknown> = {}) => ({
  id: 'share-1',
  label: 'For the client',
  createdBy: 'ada',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
  revokedAt: null,
  ...overrides,
});

const renderShare = (role: 'OWNER' | 'EDITOR' | 'VIEWER') =>
  render(
    <MemoryRouter>
      <SharePopover projectId={PROJECT} role={role} />
    </MemoryRouter>,
  );

afterEach(() => vi.unstubAllGlobals());

describe('SharePopover', () => {
  it('lets the owner invite someone and reports the result', async () => {
    const calls = mockApi({
      '/members': (call) =>
        call.method === 'POST'
          ? json(
              {
                member: {
                  userId: 'u2',
                  username: (call.body as { username: string }).username,
                  displayName: null,
                  role: 'EDITOR',
                  joinedAt: '2026-01-01T00:00:00.000Z',
                },
              },
              201,
            )
          : json({ members: [], viewerPermissions: [] }),
      '/preview/shares': () => json({ shares: [] }),
    });
    renderShare('OWNER');

    await userEvent.click(screen.getByRole('button', { name: 'Share' }));
    const popover = await screen.findByRole('dialog', { name: 'Share' });

    await userEvent.type(within(popover).getByLabelText('Username'), 'grace');
    await userEvent.click(within(popover).getByRole('button', { name: 'Add to project' }));

    await waitFor(() =>
      expect(calls.find((call) => call.method === 'POST' && call.url.endsWith('/members'))).toEqual(
        expect.objectContaining({ body: { username: 'grace', role: 'EDITOR' } }),
      ),
    );
    await waitFor(() => expect(within(popover).getByLabelText('Username')).toHaveValue(''));
  });

  it('refuses an empty username without a request', async () => {
    const calls = mockApi({
      '/members': () => json({ members: [], viewerPermissions: [] }),
      '/preview/shares': () => json({ shares: [] }),
    });
    renderShare('OWNER');

    await userEvent.click(screen.getByRole('button', { name: 'Share' }));
    const popover = await screen.findByRole('dialog', { name: 'Share' });
    await userEvent.click(within(popover).getByRole('button', { name: 'Add to project' }));

    expect(await within(popover).findByRole('alert')).toHaveTextContent('Enter a username.');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('shows an editor who has access instead of a form they cannot use', async () => {
    mockApi({
      '/members': () =>
        json({
          members: [
            {
              userId: 'u1',
              username: 'ada',
              displayName: 'Ada',
              role: 'OWNER',
              joinedAt: '2026-01-01T00:00:00.000Z',
            },
            {
              userId: 'u2',
              username: 'grace',
              displayName: null,
              role: 'EDITOR',
              joinedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          viewerPermissions: [],
        }),
    });
    renderShare('EDITOR');

    await userEvent.click(screen.getByRole('button', { name: 'Share' }));
    const popover = await screen.findByRole('dialog', { name: 'Share' });

    expect(await within(popover).findByText('Ada')).toBeInTheDocument();
    expect(within(popover).getByText('grace')).toBeInTheDocument();
    expect(within(popover).queryByLabelText('Username')).not.toBeInTheDocument();
    expect(
      within(popover).getByText('Only the project owner can make preview links.'),
    ).toBeInTheDocument();
  });

  it('makes a preview link, shows it once with a copy control, and lists the active ones', async () => {
    mockApi({
      '/members': () => json({ members: [], viewerPermissions: [] }),
      '/preview/shares': (call) =>
        call.method === 'POST'
          ? json(
              { share: share({ id: 'share-2', label: null }), url: 'https://p.example.test/t/abc' },
              201,
            )
          : json({ shares: [share()] }),
    });
    renderShare('OWNER');

    await userEvent.click(screen.getByRole('button', { name: 'Share' }));
    const popover = await screen.findByRole('dialog', { name: 'Share' });

    expect(await within(popover).findByText('For the client')).toBeInTheDocument();
    await userEvent.click(within(popover).getByRole('button', { name: 'Make link' }));

    expect(await within(popover).findByRole('textbox', { name: 'Preview link' })).toHaveValue(
      'https://p.example.test/t/abc',
    );
    expect(within(popover).getByRole('button', { name: 'Copy preview link' })).toBeInTheDocument();
    expect(
      within(popover).getByText('Copy this now. It will not be shown again.'),
    ).toBeInTheDocument();
  });

  it('links to deploying rather than offering a Deploy button', async () => {
    mockApi({
      '/members': () => json({ members: [], viewerPermissions: [] }),
      '/preview/shares': () => json({ shares: [] }),
    });
    renderShare('OWNER');

    await userEvent.click(screen.getByRole('button', { name: 'Share' }));
    const popover = await screen.findByRole('dialog', { name: 'Share' });

    expect(within(popover).getByRole('link', { name: 'Deploy this project' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT}/settings/deploy`,
    );
    expect(within(popover).queryByRole('button', { name: /Deploy/ })).not.toBeInTheDocument();
  });
});
