import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../lib/auth-context.js';
import { RegisterPage } from './RegisterPage.js';

const publicUser = {
  id: '018f0000-0000-7000-8000-000000000001',
  email: 'ada@example.test',
  username: 'ada-lovelace',
  displayName: null,
  emailVerified: false,
  isOperator: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const authenticated = {
  user: publicUser,
  session: { expiresAt: '2026-02-01T00:00:00.000Z' },
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

const anonymous = () => ({ '/api/auth/me': () => json({ user: null }) });

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/register']}>
      <AuthProvider>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/" element={<h1>Signed in home</h1>} />
          <Route path="/login" element={<h1>Sign in page</h1>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );

const valid = {
  email: 'ada@example.test',
  username: 'ada-lovelace',
  password: 'analytical-engine-1843',
};

const fill = async (values: Partial<typeof valid> = {}) => {
  const merged = { ...valid, ...values };
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByLabelText('Email')).toBeInTheDocument());
  await user.type(screen.getByLabelText('Email'), merged.email);
  await user.type(screen.getByLabelText('Username'), merged.username);
  await user.type(screen.getByLabelText('Password'), merged.password);
  return user;
};

afterEach(() => vi.unstubAllGlobals());

describe('RegisterPage', () => {
  it('creates an account and lands the user signed in', async () => {
    routeFetch({ ...anonymous(), '/api/auth/register': () => json(authenticated, 201) });

    renderPage();
    const user = await fill();
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    // Registration signs the user in, so there is nowhere to stop.
    expect(await screen.findByText('Signed in home')).toBeInTheDocument();
  });

  it('posts to the registration endpoint', async () => {
    const spy = routeFetch({
      ...anonymous(),
      '/api/auth/register': () => json(authenticated, 201),
    });

    renderPage();
    const user = await fill();
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() =>
      expect(spy.mock.calls.some(([url]) => String(url).includes('/api/auth/register'))).toBe(true),
    );
  });

  it('rejects a short password before contacting the server', async () => {
    const spy = routeFetch(anonymous());

    renderPage();
    const user = await fill({ password: 'short' });
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText(/at least 10 characters/i)).toBeInTheDocument();
    expect(spy.mock.calls.filter(([url]) => String(url).includes('/register'))).toHaveLength(0);
  });

  it('rejects a reserved username before contacting the server', async () => {
    const spy = routeFetch(anonymous());

    renderPage();
    const user = await fill({ username: 'admin' });
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText(/reserved by the platform/i)).toBeInTheDocument();
    expect(spy.mock.calls.filter(([url]) => String(url).includes('/register'))).toHaveLength(0);
  });

  it('shows a server conflict against the field that caused it', async () => {
    routeFetch({
      ...anonymous(),
      '/api/auth/register': () =>
        json(
          {
            error: {
              code: 'CONFLICT',
              message: 'An account with that email already exists',
              requestId: 'r',
              details: { field: 'email' },
            },
          },
          409,
        ),
    });

    renderPage();
    const user = await fill();
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(
      await screen.findByText('An account with that email already exists'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows server validation errors against their fields', async () => {
    routeFetch({
      ...anonymous(),
      '/api/auth/register': () =>
        json(
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'The submitted values are not valid',
              requestId: 'r',
              details: { fields: [{ path: 'username', message: 'Server says no' }] },
            },
          },
          422,
        ),
    });

    renderPage();
    const user = await fill();
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Server says no')).toBeInTheDocument();
  });

  it('reports rate limiting as a form-level message', async () => {
    routeFetch({
      ...anonymous(),
      '/api/auth/register': () =>
        json(
          { error: { code: 'RATE_LIMITED', message: 'Too many requests.', requestId: 'r' } },
          429,
        ),
    });

    renderPage();
    const user = await fill();
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
  });

  it('reports an unreachable server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes('/me')
          ? Promise.resolve(json({ user: null }))
          : Promise.reject(new TypeError('Failed to fetch')),
      ),
    );

    renderPage();
    const user = await fill();
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
  });

  it('clears a field error once the user edits that field', async () => {
    routeFetch({
      ...anonymous(),
      '/api/auth/register': () =>
        json(
          {
            error: {
              code: 'CONFLICT',
              message: 'That username is already taken',
              requestId: 'r',
              details: { field: 'username' },
            },
          },
          409,
        ),
    });

    renderPage();
    const user = await fill();
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByText('That username is already taken');

    await user.type(screen.getByLabelText('Username'), '-2');

    await waitFor(() =>
      expect(screen.queryByText('That username is already taken')).not.toBeInTheDocument(),
    );
  });

  it('uses a new-password field so managers offer to generate one', async () => {
    routeFetch(anonymous());
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password'),
    );
  });

  it('sends an already-signed-in visitor away', async () => {
    routeFetch({ '/api/auth/me': () => json({ user: publicUser }) });
    renderPage();
    expect(await screen.findByText('Signed in home')).toBeInTheDocument();
  });
});
