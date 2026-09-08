import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostsPanel } from './OperationsPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const host = (name: string, draining = false) => ({
  name,
  schedulable: !draining,
  draining,
  reason: null,
  cpuMillicores: { used: 0, declared: 4000 },
  memoryMb: { used: 0, declared: 4096 },
  workloads: { used: 0, declared: 10 },
});

function mockApi(names: string[]) {
  const puts: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { draining: boolean };
        puts.push({ url: String(input), body });
        return Promise.resolve(
          json({ hosts: names.map((n) => host(n, n === 'alpha' && body.draining)) }),
        );
      }
      return Promise.resolve(json({ hosts: names.map((n) => host(n)) }));
    }),
  );
  return { puts };
}

afterEach(() => vi.unstubAllGlobals());

describe('execution hosts', () => {
  it('drains a host and shows it as draining', async () => {
    const { puts } = mockApi(['alpha', 'beta']);
    render(<HostsPanel />);

    await userEvent.click((await screen.findAllByRole('button', { name: 'Drain' }))[0]!);

    await waitFor(() =>
      expect(puts).toEqual([
        { url: '/api/operations/hosts/alpha/drain', body: { draining: true } },
      ]),
    );
    expect(await screen.findByRole('button', { name: 'Resume placing work' })).toBeInTheDocument();
  });

  it('offers no drain with a single host', async () => {
    mockApi(['alpha']);
    render(<HostsPanel />);
    await screen.findByText('alpha');
    expect(screen.queryByRole('button', { name: 'Drain' })).not.toBeInTheDocument();
  });
});
