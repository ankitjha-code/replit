import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectPreviewShares } from './ProjectPreviewShares.js';

/**
 * Share links for the preview.
 *
 * The link is shown once, and a turned-off or expired link is not listed as
 * if it still worked.
 */

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

afterEach(() => vi.unstubAllGlobals());

describe('share links', () => {
  it('lists only links that still work', async () => {
    mockApi([
      share('a'),
      share('b', { revokedAt: '2026-01-01T00:00:00.000Z' }),
      share('c', { expiresAt: '2020-01-01T00:00:00.000Z' }),
    ]);
    render(<ProjectPreviewShares projectId={PROJECT} />);

    expect(await screen.findByText('link a')).toBeInTheDocument();
    expect(screen.queryByText('link b')).not.toBeInTheDocument();
    expect(screen.queryByText('link c')).not.toBeInTheDocument();
  });

  it('shows a new link once, with its lifetime and note sent', async () => {
    const { calls } = mockApi();
    render(<ProjectPreviewShares projectId={PROJECT} />);
    await screen.findByText(/No links are working/);

    await userEvent.selectOptions(screen.getByLabelText('Works for'), '1 hour');
    await userEvent.type(screen.getByLabelText('Note (optional)'), 'for the client');
    await userEvent.click(screen.getByRole('button', { name: 'Make link' }));

    expect(await screen.findByLabelText('New share link')).toHaveValue(LINK);
    expect(screen.getByText(/will not be shown again/)).toBeInTheDocument();
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      hours: 1,
      label: 'for the client',
    });
  });

  it('turns a link off', async () => {
    const { calls } = mockApi([share('a')]);
    render(<ProjectPreviewShares projectId={PROJECT} />);
    await screen.findByText('link a');

    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));

    await waitFor(() => expect(screen.queryByText('link a')).not.toBeInTheDocument());
    expect(calls.find((call) => call.method === 'DELETE')?.url).toContain('/preview/shares/a');
  });
});
