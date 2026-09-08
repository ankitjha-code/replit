import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../lib/auth-context.js';
import { LoginPage } from './LoginPage.js';

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

function routeFetch(handlers: Record<string, () => Response>) {
  const spy = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(handlers).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected request to ${url}`);
    return Promise.resolve(handlers[key]!());
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/login']}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<h1>Signed in home</h1>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );

const fill = async (identifier: string, password: string) => {
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByLabelText('Email or username')).toBeInTheDocument());
  await user.type(screen.getByLabelText('Email or username'), identifier);
  await user.type(screen.getByLabelText('Password'), password);
  return user;
};

afterEach(() => vi.unstubAllGlobals());

describe('LoginPage', () => {
  it('signs in and moves on', async () => {
    routeFetch({
      '/api/auth/me': () => json({ user: null }),
      '/api/auth/login': () =>
        json({ user: publicUser, session: { expiresAt: '2026-02-01T00:00:00.000Z' } }),
    });

    renderPage();
    const user = await fill('ada@example.test', 'analytical-engine-1843');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Signed in home')).toBeInTheDocument();
  });

  it('sends what was typed', async () => {
    const spy = routeFetch({
      '/api/auth/me': () => json({ user: null }),
      '/api/auth/login': () =>
        json({ user: publicUser, session: { expiresAt: '2026-02-01T00:00:00.000Z' } }),
    });

    renderPage();
    const user = await fill('ada', 'a-passphrase');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(1));
    const loginCall = spy.mock.calls.find(([url]) => String(url).includes('/login'));
    expect(loginCall?.[1]?.body).toBe('{"identifier":"ada","password":"a-passphrase"}');
  });

  it('shows a rejected sign-in above the form, not against a field', async () => {
    // Marking the password field would say the identifier was right, which is
    // exactly what the server declined to reveal.
    routeFetch({
      '/api/auth/me': () => json({ user: null }),
      '/api/auth/login': () =>
        json(
          {
            error: {
              code: 'UNAUTHENTICATED',
              message: 'Incorrect email, username or password',
              requestId: 'r',
            },
          },
          401,
        ),
    });

    renderPage();
    const user = await fill('ada@example.test', 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Incorrect email, username or password',
    );
    expect(screen.getByLabelText('Password')).not.toHaveAttribute('aria-invalid');
  });

  it('reports rate limiting', async () => {
    routeFetch({
      '/api/auth/me': () => json({ user: null }),
      '/api/auth/login': () =>
        json(
          { error: { code: 'RATE_LIMITED', message: 'Too many requests.', requestId: 'r' } },
          429,
        ),
    });

    renderPage();
    const user = await fill('ada', 'guess');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
  });

  it('reports an unreachable server', async () => {
    const spy = vi.fn((input: RequestInfo | URL) =>
      String(input).includes('/me')
        ? Promise.resolve(json({ user: null }))
        : Promise.reject(new TypeError('Failed to fetch')),
    );
    vi.stubGlobal('fetch', spy);

    renderPage();
    const user = await fill('ada', 'passphrase');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
  });

  it('will not submit an empty form', async () => {
    const spy = routeFetch({ '/api/auth/me': () => json({ user: null }) });

    renderPage();
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeInTheDocument());
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Enter your email or username')).toBeInTheDocument();
    expect(spy.mock.calls.filter(([url]) => String(url).includes('/login'))).toHaveLength(0);
  });

  it('applies no password policy, so an older password can still be used', async () => {
    // Rules that apply when choosing a credential must not apply when
    // presenting one.
    const spy = routeFetch({
      '/api/auth/me': () => json({ user: null }),
      '/api/auth/login': () =>
        json({ user: publicUser, session: { expiresAt: '2026-02-01T00:00:00.000Z' } }),
    });

    renderPage();
    const user = await fill('ada', 'short');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() =>
      expect(spy.mock.calls.some(([url]) => String(url).includes('/login'))).toBe(true),
    );
  });

  it('uses a current-password field so managers offer the right entry', async () => {
    routeFetch({ '/api/auth/me': () => json({ user: null }) });
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password'),
    );
  });

  it('sends an already-signed-in visitor away', async () => {
    routeFetch({ '/api/auth/me': () => json({ user: publicUser }) });
    renderPage();
    expect(await screen.findByText('Signed in home')).toBeInTheDocument();
  });
});
