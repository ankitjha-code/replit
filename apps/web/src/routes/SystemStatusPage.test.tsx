import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemStatusPage } from './SystemStatusPage.js';

const health = (body: unknown, status = 200) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );

afterEach(() => vi.unstubAllGlobals());

describe('SystemStatusPage', () => {
  it('renders real readiness from the control plane', async () => {
    health({
      status: 'ok',
      service: 'api',
      version: '0.1.0',
      uptimeSeconds: 12,
      dependencies: [{ name: 'postgres', status: 'up', latencyMs: 3 }],
    });

    render(<SystemStatusPage />);
    expect(await screen.findByText('postgres')).toBeInTheDocument();
    expect(screen.getByText(/v0\.1\.0/)).toBeInTheDocument();
  });

  it('states plainly that no dependency is registered instead of faking one', async () => {
    health({
      status: 'ok',
      service: 'api',
      version: '0.1.0',
      uptimeSeconds: 1,
      dependencies: [],
    });

    render(<SystemStatusPage />);
    expect(await screen.findByText('No dependencies registered yet.')).toBeInTheDocument();
  });

  it('surfaces an unreachable control plane', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    render(<SystemStatusPage />);
    expect(await screen.findByText('Could not reach the server')).toBeInTheDocument();
  });
});
