import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './auth-context.js';

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
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Routes each call by URL, so one test can script a whole flow. */
function routeFetch(handlers: Record<string, () => Response | Promise<Response>>) {
  const spy = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(handlers).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected request to ${url}`);
    return Promise.resolve(handlers[key]!());
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function Probe(): React.JSX.Element {
  const { status, user, signIn, signOut } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.username ?? 'none'}</span>
      <button
        type="button"
        onClick={() => void signIn({ identifier: 'ada', password: 'x' }).catch(() => undefined)}
      >
        sign in
      </button>
      <button type="button" onClick={() => void signOut()}>
        sign out
      </button>
    </div>
  );
}

const renderProbe = () =>
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );

afterEach(() => vi.unstubAllGlobals());

describe('AuthProvider', () => {
  it('starts in an unknown state rather than assuming signed out', async () => {
    // Assuming signed out makes the page flash from anonymous to signed in on
    // every load.
    routeFetch({ '/api/auth/me': () => json({ user: publicUser }) });
    renderProbe();
    expect(screen.getByTestId('status')).toHaveTextContent('unknown');
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
  });

  it('reports an existing session on load', async () => {
    routeFetch({ '/api/auth/me': () => json({ user: publicUser }) });
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('ada'));
  });

  it('reports no session when the server says nobody is signed in', async () => {
    routeFetch({ '/api/auth/me': () => json({ user: null }) });
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
  });

  it('treats an unreachable server as signed out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
  });

  it('moves to signed in after a successful sign-in', async () => {
    routeFetch({
      '/api/auth/me': () => json({ user: null }),
      '/api/auth/login': () =>
        json({ user: publicUser, session: { expiresAt: '2026-02-01T00:00:00.000Z' } }),
    });

    const user = userEvent.setup();
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));

    await user.click(screen.getByRole('button', { name: 'sign in' }));
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('ada'));
  });

  it('stays signed out when sign-in is rejected', async () => {
    routeFetch({
      '/api/auth/me': () => json({ user: null }),
      '/api/auth/login': () =>
        json({ error: { code: 'UNAUTHENTICATED', message: 'nope', requestId: 'r' } }, 401),
    });

    const user = userEvent.setup();
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));

    await user.click(screen.getByRole('button', { name: 'sign in' }));
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('none'));
  });

  it('clears the session on sign-out', async () => {
    routeFetch({
      '/api/auth/me': () => json({ user: publicUser }),
      '/api/auth/logout': () => json(null, 204),
    });

    const user = userEvent.setup();
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('ada'));

    await user.click(screen.getByRole('button', { name: 'sign out' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
  });

  it('clears the session even when sign-out fails', async () => {
    // The user asked to leave. Continuing to show a signed-in view would be
    // worse than being briefly wrong about the cookie.
    routeFetch({
      '/api/auth/me': () => json({ user: publicUser }),
      '/api/auth/logout': () =>
        json({ error: { code: 'INTERNAL_ERROR', message: 'boom', requestId: 'r' } }, 500),
    });

    const user = userEvent.setup();
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('ada'));

    await user.click(screen.getByRole('button', { name: 'sign out' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
  });

  it('never holds a session token, only the user', async () => {
    // The session lives in an httpOnly cookie the browser cannot read.
    routeFetch({ '/api/auth/me': () => json({ user: publicUser }) });
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('ada'));
    expect(document.body.innerHTML).not.toContain('token');
  });

  it('refuses to be used outside a provider', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(/must be used inside an AuthProvider/);
    quiet.mockRestore();
  });
});
