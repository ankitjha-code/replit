import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiProvider, clearToasts } from '../ui/index.js';
import { ProjectPreviewShares } from './ProjectPreviewShares.js';

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';
const LINK = 'http://p.localhost:4100/?share=secret-token';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const share = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  label: `link ${id}`,
  createdBy: 'ada',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  revokedAt: null,
  ...overrides,
});

function mockApi(shares: unknown[] = []) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  let listed = shares;

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url: String(input), body });

      if (method === 'POST') {
        const made = share('new', { label: body?.label ?? null });
        listed = [...listed, made];
        return Promise.resolve(json({ share: made, url: LINK }, 201));
      }
      if (method === 'DELETE') {
        listed = [];
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(json({ shares: listed }));
    }),
  );

  return { calls };
}

function renderShares() {
  render(
    <UiProvider>
      <ProjectPreviewShares projectId={PROJECT} />
    </UiProvider>,
  );
}

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

describe('share links', () => {
  it('lists only links that still work', async () => {
    mockApi([
      share('a'),
      share('b', { revokedAt: '2026-01-01T00:00:00.000Z' }),
      share('c', { expiresAt: '2020-01-01T00:00:00.000Z' }),
    ]);
    renderShares();

    expect(await screen.findByText('link a')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make link' })).not.toHaveClass('ui-button--primary');
    expect(screen.queryByText('link b')).not.toBeInTheDocument();
    expect(screen.queryByText('link c')).not.toBeInTheDocument();
  });

  it('shows a new link once, with its lifetime and note sent', async () => {
    const { calls } = mockApi();
    renderShares();
    await screen.findByText('No active preview links.');

    await userEvent.selectOptions(screen.getByLabelText('Works for'), '1 hour');
    await userEvent.type(screen.getByLabelText('Note (optional)'), 'for the client');
    await userEvent.click(screen.getByRole('button', { name: 'Make link' }));

    expect(await screen.findByLabelText('New share link')).toHaveValue(LINK);
    expect(screen.getByText(/will not be shown again/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy preview link' })).toBeInTheDocument();
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      hours: 1,
      label: 'for the client',
    });
  });

  it('revokes a link after asking', async () => {
    const { calls } = mockApi([share('a')]);
    renderShares();
    await screen.findByText('link a');

    await userEvent.click(screen.getByRole('button', { name: 'Revoke link for link a' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke this link?' });
    expect(within(dialog).getByText('Anyone using it loses access now.')).toBeInTheDocument();
    expect(calls.find((call) => call.method === 'DELETE')).toBeUndefined();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke link for link a' }));

    await waitFor(() => expect(screen.queryByText('link a')).not.toBeInTheDocument());
    expect(calls.find((call) => call.method === 'DELETE')?.url).toContain('/preview/shares/a');
    expect(await screen.findByText('No active preview links.')).toBeInTheDocument();
  });
});
