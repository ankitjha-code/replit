import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../lib/auth-context.js';
import { ResetPasswordPage } from './ResetPasswordPage.js';

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

const renderPage = (search = '?token=abc') =>
  render(
    <MemoryRouter initialEntries={[`/reset-password${search}`]}>
      <AuthProvider>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/login" element={<h1>Sign in page</h1>} />
          <Route path="/forgot-password" element={<h1>Forgot page</h1>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );

const requests = (spy: ReturnType<typeof routeFetch>, path: string) =>
  spy.mock.calls.filter(([url]) => String(url).includes(path));

async function fill(password: string, confirm = password) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('New password'), password);
  await user.type(screen.getByLabelText('Confirm password'), confirm);
  return user;
}

afterEach(() => vi.unstubAllGlobals());

describe('ResetPasswordPage', () => {
  it('refuses a link with no code on arrival and points at a new one', async () => {
    routeFetch(anonymous());
    renderPage('');
    expect(
      screen.getByRole('heading', { level: 1, name: 'This link no longer works' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/incomplete/);
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
    await waitFor(() => expect(screen.queryByLabelText('New password')).toBeNull());
  });

  it('applies the shared password rules before contacting the server', async () => {
    const spy = routeFetch(anonymous());
    renderPage();
    const user = await fill('short');
    await user.click(screen.getByRole('button', { name: 'Set my new password' }));
    expect(await screen.findByText(/at least 10 characters/i)).toBeInTheDocument();
    expect(requests(spy, '/password-reset/complete')).toHaveLength(0);
  });

  it('asks for the two passwords to match', async () => {
    const spy = routeFetch(anonymous());
    renderPage();
    const user = await fill('analytical-engine-1843', 'analytical-engine-1844');
    await user.click(screen.getByRole('button', { name: 'Set my new password' }));
    expect(await screen.findByText('The two passwords do not match')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute('aria-invalid', 'true');
    expect(requests(spy, '/password-reset/complete')).toHaveLength(0);
  });

  it('sends the token with the password and shows the signed-out-everywhere screen', async () => {
    const spy = routeFetch({
      ...anonymous(),
      '/api/auth/password-reset/complete': () => new Response(null, { status: 204 }),
    });
    renderPage('?token=the-token');
    const user = await fill('analytical-engine-1843');
    await user.click(screen.getByRole('button', { name: 'Set my new password' }));

    expect(await screen.findByRole('heading', { name: 'Password changed' })).toBeInTheDocument();
    expect(screen.getByText(/signed out everywhere/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    const [, init] = requests(spy, '/password-reset/complete')[0]!;
    expect(init?.body).toBe('{"token":"the-token","password":"analytical-engine-1843"}');
  });

  it('treats a refused token as a dead link, not as something to retype', async () => {
    routeFetch({
      ...anonymous(),
      '/api/auth/password-reset/complete': () =>
        json(
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'That link has expired. Ask for a new one.',
              requestId: 'r',
            },
          },
          422,
        ),
    });
    renderPage();
    const user = await fill('analytical-engine-1843');
    await user.click(screen.getByRole('button', { name: 'Set my new password' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'This link no longer works' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('That link has expired');
    expect(screen.getByRole('link', { name: 'Request a new link' })).toBeInTheDocument();
  });

  it('shows a server password rule against the field', async () => {
    routeFetch({
      ...anonymous(),
      '/api/auth/password-reset/complete': () =>
        json(
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'The submitted values are not valid',
              requestId: 'r',
              details: { fields: [{ path: 'password', message: 'Server says no' }] },
            },
          },
          422,
        ),
    });
    renderPage();
    const user = await fill('analytical-engine-1843');
    await user.click(screen.getByRole('button', { name: 'Set my new password' }));
    expect(await screen.findByText('Server says no')).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true');
  });

  it('reports an unreachable server above the form and keeps what was typed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes('/me')
          ? Promise.resolve(json({ user: null }))
          : Promise.reject(new TypeError('Failed to fetch')),
      ),
    );
    renderPage();
    const user = await fill('analytical-engine-1843');
    await user.click(screen.getByRole('button', { name: 'Set my new password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
    expect(screen.getByLabelText('New password')).toHaveValue('analytical-engine-1843');
  });

  it('can reveal both passwords', async () => {
    routeFetch(anonymous());
    renderPage();
    const toggles = screen.getAllByRole('button', { name: 'Show characters' });
    expect(toggles).toHaveLength(2);
    await userEvent.setup().click(toggles[0]!);
    expect(screen.getByLabelText('New password')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute('type', 'password');
  });
});
