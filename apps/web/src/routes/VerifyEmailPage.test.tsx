import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../lib/auth-context.js';
import { VerifyEmailPage } from './VerifyEmailPage.js';

const publicUser = {
  id: '018f0000-0000-7000-8000-000000000001',
  email: 'ada@example.test',
  username: 'ada',
  displayName: null,
  emailVerified: true,
  isOperator: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function routeFetch(handlers: Record<string, () => Response | Promise<Response>>) {
  const spy = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(handlers).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected request to ${url}`);
    return Promise.resolve(handlers[key]!());
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const renderPage = (search = '?token=abc') =>
  render(
    <MemoryRouter initialEntries={[`/verify-email${search}`]}>
      <AuthProvider>
        <Routes>
          <Route path="/verify-email" element={<VerifyEmailPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );

afterEach(() => vi.unstubAllGlobals());

describe('VerifyEmailPage', () => {
  it('says it is checking, then that the address is confirmed', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = routeFetch({
      '/api/auth/me': () => json({ user: publicUser }),
      '/api/auth/verification/confirm': () => gate.then(() => new Response(null, { status: 204 })),
    });
    renderPage('?token=the-token');

    const heading = screen.getByRole('heading', { level: 1, name: 'Confirming your email…' });
    expect(heading.closest('section')).toHaveAttribute('aria-busy', 'true');

    release!();
    expect(await screen.findByRole('heading', { name: 'Email confirmed' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to your projects' })).toHaveAttribute('href', '/');

    const confirm = spy.mock.calls.find(([url]) => String(url).includes('/verification/confirm'));
    expect(confirm?.[1]?.body).toBe('{"token":"the-token"}');
    await waitFor(() =>
      expect(spy.mock.calls.filter(([url]) => String(url).includes('/me')).length).toBeGreaterThan(
        1,
      ),
    );
  });

  it('redeems the token once', async () => {
    const spy = routeFetch({
      '/api/auth/me': () => json({ user: null }),
      '/api/auth/verification/confirm': () => new Response(null, { status: 204 }),
    });
    renderPage();
    await screen.findByRole('heading', { name: 'Email confirmed' });
    expect(spy.mock.calls.filter(([url]) => String(url).includes('/confirm'))).toHaveLength(1);
  });

  it('shows the server reason and sends a signed-out visitor through sign-in to the account page', async () => {
    routeFetch({
      '/api/auth/me': () => json({ user: null }),
      '/api/auth/verification/confirm': () =>
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
    expect(
      await screen.findByRole('heading', { name: 'This link no longer works' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('That link has expired');
    expect(screen.getByRole('link', { name: 'Sign in to request a new link' })).toHaveAttribute(
      'href',
      '/login?next=/account',
    );
  });

  it('sends a signed-in visitor straight to the account page after a failure', async () => {
    routeFetch({
      '/api/auth/me': () => json({ user: publicUser }),
      '/api/auth/verification/confirm': () =>
        json(
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'That link has already been used.',
              requestId: 'r',
            },
          },
          422,
        ),
    });
    renderPage();
    expect(await screen.findByRole('link', { name: 'Request a new link' })).toHaveAttribute(
      'href',
      '/account',
    );
  });

  it('does not call the link dead when it was only rate limited, and tries it again', async () => {
    let answers = 0;
    const spy = routeFetch({
      '/api/auth/me': () => json({ user: null }),
      '/api/auth/verification/confirm': () => {
        answers += 1;
        return answers === 1
          ? json(
              {
                error: {
                  code: 'RATE_LIMITED',
                  message: 'Too many requests. Try again shortly.',
                  requestId: 'r',
                },
              },
              429,
            )
          : new Response(null, { status: 204 });
      },
    });
    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'This link could not be checked' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'This link no longer works' })).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Too many requests');

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Email confirmed' })).toBeInTheDocument();
    expect(spy.mock.calls.filter(([url]) => String(url).includes('/confirm'))).toHaveLength(2);
  });

  it('treats a link without a code as a failure without asking the server', async () => {
    const spy = routeFetch({ '/api/auth/me': () => json({ user: null }) });
    renderPage('');
    expect(
      await screen.findByRole('heading', { name: 'This link no longer works' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/incomplete/);
    expect(spy.mock.calls.filter(([url]) => String(url).includes('/confirm'))).toHaveLength(0);
  });

  it('announces the outcome in a polite live region', async () => {
    routeFetch({
      '/api/auth/me': () => json({ user: null }),
      '/api/auth/verification/confirm': () => new Response(null, { status: 204 }),
    });
    renderPage();
    const body = await screen.findByText(/Your address is confirmed/);
    expect(body.closest('[aria-live="polite"]')).not.toBeNull();
  });
});
