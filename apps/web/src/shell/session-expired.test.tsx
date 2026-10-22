import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequireAuth } from '../components/RequireAuth.js';
import { apiRequest } from '../lib/api-client.js';
import {
  AuthProvider,
  SESSION_REPOLL_MS,
  SESSION_RESTORED_EVENT,
  useAuth,
} from '../lib/auth-context.js';
import { NavigationGuardProvider, useRegisterGuard } from '../lib/navigation-guard.js';
import { SESSION_ENDED_MESSAGE, SessionBanner } from './SessionBanner.js';

/**
 * What a signed-in page sees when its session ends underneath it: with
 * nothing to lose it is sent to sign in, remembering where it was; with
 * unsaved work it stays, a banner appears, and the session is re-checked
 * until it is back.
 */

const publicUser = {
  id: '018f0000-0000-7000-8000-000000000001',
  email: 'ada@example.test',
  username: 'ada',
  displayName: null,
  emailVerified: false,
  isOperator: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const unauthenticated = () =>
  json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in again.', requestId: 'r' } }, 401);

function routeFetch(handlers: Record<string, () => Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const key = Object.keys(handlers).find((k) => url.includes(k));
      if (!key) throw new Error(`unexpected request to ${url}`);
      return Promise.resolve(handlers[key]!());
    }),
  );
}

function Page({ dirty }: { dirty: boolean }): React.JSX.Element {
  const { status, sessionEnded } = useAuth();
  useRegisterGuard('page', {
    isDirty: () => dirty,
    flush: () => Promise.resolve(),
  });
  return (
    <output data-testid="page">
      {status}
      {sessionEnded ? ' ended' : ''}
    </output>
  );
}

function Login(): React.JSX.Element {
  const location = useLocation();
  const { reason } = useAuth();
  const from = (location.state as { from?: string } | null)?.from ?? 'nowhere';
  return (
    <output data-testid="login">
      {from} {reason ?? 'no-reason'}
    </output>
  );
}

const renderApp = (dirty: boolean) =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/account/security']}>
        <NavigationGuardProvider>
          <SessionBanner />
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              path="/account/*"
              element={
                <RequireAuth>
                  <Page dirty={dirty} />
                </RequireAuth>
              }
            />
          </Routes>
        </NavigationGuardProvider>
      </MemoryRouter>
    </AuthProvider>,
  );

/** A protected request that the server now refuses. */
const trigger401 = () =>
  act(async () => {
    await apiRequest('/api/projects/p1').catch(() => undefined);
  });

describe('an expired session', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends a page with nothing to lose to sign in, remembering where it was', async () => {
    routeFetch({
      '/api/auth/me': () => json({ user: publicUser }),
      '/api/projects/p1': unauthenticated,
    });
    renderApp(false);
    await waitFor(() => expect(screen.getByTestId('page')).toHaveTextContent('authenticated'));

    await trigger401();

    await waitFor(() =>
      expect(screen.getByTestId('login')).toHaveTextContent('/account/security expired'),
    );
    expect(screen.queryByText(SESSION_ENDED_MESSAGE)).toBeNull();
  });

  it('keeps a page with unsaved work, shows the banner, and re-checks until the session is back', async () => {
    let me = (): Response => json({ user: publicUser });
    routeFetch({
      '/api/auth/me': () => me(),
      '/api/projects/p1': unauthenticated,
    });
    const restored = vi.fn();
    window.addEventListener(SESSION_RESTORED_EVENT, restored);

    renderApp(true);
    await waitFor(() => expect(screen.getByTestId('page')).toHaveTextContent('authenticated'));

    // The session is gone on the server now.
    me = () => json({ user: null });
    await trigger401();

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(SESSION_ENDED_MESSAGE);
    expect(banner.querySelector('a[target="_blank"]')).toHaveAttribute('href', '/login');
    expect(screen.getByTestId('page')).toHaveTextContent('authenticated ended');
    expect(screen.queryByTestId('login')).toBeNull();

    // Still gone at the first re-check.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_REPOLL_MS);
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(restored).not.toHaveBeenCalled();

    // The user signed in again in another tab.
    me = () => json({ user: publicUser });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_REPOLL_MS);
    });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByTestId('page')).toHaveTextContent('authenticated');
    expect(screen.getByTestId('page')).not.toHaveTextContent('ended');
    expect(restored).toHaveBeenCalledTimes(1);

    window.removeEventListener(SESSION_RESTORED_EVENT, restored);
  });

  it('ignores a 401 from the sign-in form itself', async () => {
    routeFetch({
      '/api/auth/me': () => json({ user: publicUser }),
      '/api/auth/login': unauthenticated,
    });
    renderApp(false);
    await waitFor(() => expect(screen.getByTestId('page')).toHaveTextContent('authenticated'));

    await act(async () => {
      await apiRequest('/api/auth/login', { method: 'POST', body: {} }).catch(() => undefined);
    });
    expect(screen.getByTestId('page')).toHaveTextContent('authenticated');
    expect(screen.queryByTestId('login')).toBeNull();
  });
});
