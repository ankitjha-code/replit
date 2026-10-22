import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForgotPasswordPage } from './ForgotPasswordPage.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const ready = (dependencies: { name: string; status: 'up' | 'down' | 'unknown' }[]) =>
  json({ status: 'ok', service: 'api', version: '0.1.0', uptimeSeconds: 1, dependencies });

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

const mailUp = () => ready([{ name: 'mail', status: 'up' }]);

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/forgot-password']}>
      <ForgotPasswordPage />
    </MemoryRouter>,
  );

const requests = (spy: ReturnType<typeof routeFetch>, path: string) =>
  spy.mock.calls.filter(([url]) => String(url).includes(path));

afterEach(() => vi.unstubAllGlobals());

describe('ForgotPasswordPage', () => {
  it('asks for a valid address before contacting the server', async () => {
    const spy = routeFetch({ '/health/ready': mailUp });
    renderPage();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email address'), 'not-an-address');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid email address');
    expect(requests(spy, '/password-reset')).toHaveLength(0);
  });

  it('says the same thing whatever the server knew about the address', async () => {
    const spy = routeFetch({
      '/health/ready': mailUp,
      '/api/auth/password-reset': () => json({ accepted: true }, 202),
    });
    renderPage();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email address'), 'ada@example.test');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByText(/If there is an account for ada@example.test/)).toBeInTheDocument();
    const [, init] = requests(spy, '/password-reset')[0]!;
    expect(init?.body).toBe('{"email":"ada@example.test"}');
  });

  it('lets the user ask again after a minute, and says so meanwhile', async () => {
    const spy = routeFetch({
      '/health/ready': mailUp,
      '/api/auth/password-reset': () => json({ accepted: true }, 202),
    });
    renderPage();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email address'), 'ada@example.test');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    await screen.findByRole('heading', { name: 'Check your email' });

    const again = screen.getByRole('button', { name: 'Send another link' });
    expect(again).toBeDisabled();
    expect(again).toHaveAccessibleDescription(/You can ask again in \d+s/);
    expect(requests(spy, '/password-reset')).toHaveLength(1);
  });

  it('reports rate limiting with the wait the server gave', async () => {
    routeFetch({
      '/health/ready': mailUp,
      '/api/auth/password-reset': () =>
        json(
          { error: { code: 'RATE_LIMITED', message: 'Too many requests.', requestId: 'r' } },
          429,
          { 'retry-after': '180' },
        ),
    });
    renderPage();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email address'), 'ada@example.test');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many requests');
    expect(alert).toHaveTextContent('Try again in about 3 minutes');
  });

  it('offers a retry when the server could not be reached', async () => {
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (String(input).includes('/health/ready')) return Promise.resolve(mailUp());
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve(json({ accepted: true }, 202));
      }),
    );
    renderPage();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email address'), 'ada@example.test');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
  });

  it('says up front when this installation cannot send email, and hides the form', async () => {
    routeFetch({ '/health/ready': () => ready([{ name: 'storage', status: 'up' }]) });
    renderPage();
    expect(await screen.findByText('This installation cannot send email')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText('Email address')).toBeNull());
  });

  it('warns when the mail server is down but still lets the user ask', async () => {
    routeFetch({ '/health/ready': () => ready([{ name: 'mail', status: 'down' }]) });
    renderPage();
    expect(await screen.findByText(/mail server is not answering/)).toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
  });

  it('keeps the form when readiness itself cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    renderPage();
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
