import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../lib/auth-context.js';
import { SystemStatusPage } from './SystemStatusPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const operator = {
  id: '018f0000-0000-7000-8000-000000000009',
  email: 'ops@example.test',
  username: 'ops',
  displayName: null,
  emailVerified: true,
  isOperator: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const stubFetch = (ready: () => Response | Promise<Response>, me: unknown = { user: operator }) =>
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/me')) return Promise.resolve(json(me));
      if (url.includes('/health/ready')) return Promise.resolve(ready());
      return Promise.reject(new Error(`unexpected request to ${url}`));
    }),
  );

const health = (body: unknown, status = 200) => stubFetch(() => json(body, status));

const renderPage = () =>
  render(
    <AuthProvider>
      <MemoryRouter>
        <SystemStatusPage />
      </MemoryRouter>
    </AuthProvider>,
  );

afterEach(() => vi.unstubAllGlobals());

describe('SystemStatusPage', () => {
  it('renders real readiness from the API', async () => {
    health({
      status: 'ok',
      service: 'api',
      version: '0.1.0',
      uptimeSeconds: 93_784,
      dependencies: [{ name: 'postgres', status: 'up', latencyMs: 3 }],
    });

    renderPage();
    expect(await screen.findByRole('heading', { name: 'System status' })).toBeInTheDocument();
    expect(await screen.findByText('postgres')).toBeInTheDocument();
    expect(screen.getByText('Version')).toBeInTheDocument();
    expect(screen.getByText('0.1.0')).toBeInTheDocument();
    expect(screen.getByText('Up for')).toBeInTheDocument();
    expect(screen.getByText('1d 2h')).toBeInTheDocument();
    expect(screen.getByText('Up')).toBeInTheDocument();
    expect(screen.getByText('All systems up')).toBeInTheDocument();
    expect(screen.getByText('3 ms')).toBeInTheDocument();
  });

  it('states plainly that no dependency is registered instead of faking one', async () => {
    health({
      status: 'ok',
      service: 'api',
      version: '0.1.0',
      uptimeSeconds: 1,
      dependencies: [],
    });

    renderPage();
    expect(await screen.findByText('No dependencies registered yet.')).toBeInTheDocument();
  });

  it('names a dependency that is down', async () => {
    health({
      status: 'degraded',
      service: 'api',
      version: '0.1.0',
      uptimeSeconds: 1,
      dependencies: [{ name: 'redis', status: 'down', detail: 'connection refused' }],
    });

    renderPage();
    expect(await screen.findByText('redis')).toBeInTheDocument();
    expect(screen.getByText('Down')).toBeInTheDocument();
    expect(screen.getByText('connection refused')).toBeInTheDocument();
    expect(screen.getByText('Degraded')).toBeInTheDocument();
  });

  it('surfaces an unreachable API with a way to try again', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    renderPage();
    expect(await screen.findByText('Could not reach the server')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows anybody but an operator the not-found page, without reading readiness', async () => {
    const ready = vi.fn(() => json({ status: 'ok', dependencies: [] }));
    stubFetch(ready, { user: { ...operator, isOperator: false } });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'System status' })).toBeNull();
    expect(ready).not.toHaveBeenCalled();
  });

  it('tells an operator on a plain-HTTP installation why previews open in a tab', async () => {
    stubFetch(
      () =>
        json({
          status: 'ok',
          service: 'api',
          version: '0.1.0',
          uptimeSeconds: 1,
          dependencies: [],
        }),
      { user: operator },
    );
    renderPage();
    expect(await screen.findByText(/PREVIEW_SCHEME=https/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Operations' })).toHaveAttribute('href', '/operations');
  });
});
