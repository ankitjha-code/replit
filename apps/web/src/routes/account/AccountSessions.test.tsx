import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearToasts } from '../../ui/index.js';
import { describeAgent } from './SessionsSection.js';
import {
  accountHandlers,
  json,
  meThenNobody,
  renderAccount,
  routeFetch,
  sessions,
} from './test-helpers.js';

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

describe('Account sessions', () => {
  it('lists every session, marks this device and names each action after the device', async () => {
    routeFetch({ ...accountHandlers(), 'GET /api/account/sessions': () => json(sessions()) });
    renderAccount('/account/sessions');

    await screen.findByText('Firefox on Windows');
    const table = screen.getByRole('table', { name: 'Sessions of this account' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Chrome on macOS')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('This device')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('127.0.0.1')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Firefox on Windows')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Not recorded')).toBeInTheDocument();

    expect(
      screen.getByRole('button', { name: 'Revoke session on Chrome on macOS' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Revoke session on Firefox on Windows' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out everywhere' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke other sessions' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(document.title).toBe('Sessions · Account · Workspace');
  });

  it('revokes another session after a confirm and re-reads the list', async () => {
    let reads = 0;
    const calls = routeFetch({
      ...accountHandlers(),
      'GET /api/account/sessions': () => {
        reads += 1;
        const all = sessions();
        return json(reads === 1 ? all : { sessions: all.sessions.slice(0, 1) });
      },
      'DELETE /api/account/sessions/sess-other': () => new Response(null, { status: 204 }),
    });
    renderAccount('/account/sessions');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Revoke session on Firefox on Windows' }),
    );
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Revoke the session on Firefox on Windows?',
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke session' }));

    await waitFor(() => expect(calls).toContain('DELETE /api/account/sessions/sess-other'));
    expect(await screen.findByText('Session revoked')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Firefox on Windows')).toBeNull());
  });

  it('revoking this device warns, then leaves the person signed out', async () => {
    const calls = routeFetch({
      ...accountHandlers(),
      'GET /api/auth/me': meThenNobody(),
      'GET /api/account/sessions': () => json(sessions()),
      'DELETE /api/account/sessions/sess-current': () => new Response(null, { status: 204 }),
    });
    renderAccount('/account/sessions');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Revoke session on Chrome on macOS' }),
    );
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Revoke the session on Chrome on macOS?',
    });
    expect(dialog).toHaveTextContent('you will be signed out here');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke session' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(calls).toContain('DELETE /api/account/sessions/sess-current');
  });

  it('signs out everywhere through the account-wide endpoint, then asks who we are', async () => {
    const calls = routeFetch({
      ...accountHandlers(),
      'GET /api/auth/me': meThenNobody(),
      'GET /api/account/sessions': () => json(sessions()),
      'POST /api/auth/logout-all': () => new Response(null, { status: 204 }),
    });
    renderAccount('/account/sessions');

    await userEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Sign out everywhere?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    const logout = calls.indexOf('POST /api/auth/logout-all');
    expect(logout).toBeGreaterThan(-1);
    expect(calls.slice(logout + 1)).toContain('GET /api/auth/me');
  });

  it('revokes the other sessions and reports how many went', async () => {
    const calls = routeFetch({
      ...accountHandlers(),
      'GET /api/account/sessions': () => json(sessions()),
      'POST /api/account/sessions/revoke-others': () => json({ signedOut: 1 }),
    });
    renderAccount('/account/sessions');

    await userEvent.click(await screen.findByRole('button', { name: 'Revoke other sessions' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke the other session?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke other sessions' }));

    expect(await screen.findByText('One other session was revoked')).toBeInTheDocument();
    expect(calls).toContain('POST /api/account/sessions/revoke-others');
  });

  it('shows a failed read with a retry and sends unknown account routes to Not found', async () => {
    let attempts = 0;
    routeFetch({
      ...accountHandlers(),
      'GET /api/account/sessions': () => {
        attempts += 1;
        return attempts === 1
          ? json({ error: { code: 'INTERNAL', message: 'Sessions are unavailable.' } }, 503)
          : json(sessions());
      },
    });
    renderAccount('/account/sessions');
    expect(await screen.findByRole('alert')).toHaveTextContent('Sessions are unavailable.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Chrome on macOS')).toBeInTheDocument();
  });

  it('renders Not found for an account route that does not exist', async () => {
    routeFetch(accountHandlers());
    renderAccount('/account/nonsense');
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeVisible();
  });

  it('describes a user agent in a couple of words', () => {
    expect(describeAgent(null)).toBe('An unnamed client');
    expect(describeAgent('Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0')).toBe('Firefox on Linux');
    expect(describeAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605.1')).toBe(
      'Safari on iOS',
    );
    expect(describeAgent('curl/8.4.0')).toBe('A browser');
  });
});
