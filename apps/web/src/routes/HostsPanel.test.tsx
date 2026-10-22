import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiProvider, clearToasts } from '../ui/index.js';
import { HostsPanel } from './OperationsPage.js';
import { host, json } from './operations/test-helpers.js';

function mockApi(names: string[], reason: string | null = null) {
  const puts: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { draining: boolean };
        puts.push({ url: String(input), body });
        return Promise.resolve(
          json({ hosts: names.map((n) => host(n, n === 'alpha' && body.draining, reason)) }),
        );
      }
      return Promise.resolve(json({ hosts: names.map((n) => host(n, false, reason)) }));
    }),
  );
  return { puts };
}

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

const renderHosts = () =>
  render(
    <UiProvider>
      <HostsPanel />
    </UiProvider>,
  );

describe('execution hosts', () => {
  it('drains a host after a confirm and shows it as draining', async () => {
    const { puts } = mockApi(['alpha', 'beta']);
    renderHosts();

    const drain = await screen.findByRole('button', { name: 'Drain alpha' });
    // The visible label stays the short verb; the row names the host.
    expect(drain).toHaveTextContent('Drain');
    await userEvent.click(drain);
    const dialog = await screen.findByRole('alertdialog', { name: 'Drain alpha?' });
    expect(puts).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Drain alpha' }));

    await waitFor(() =>
      expect(puts).toEqual([
        { url: '/api/operations/hosts/alpha/drain', body: { draining: true } },
      ]),
    );
    const resume = await screen.findByRole('button', { name: 'Resume placing work on alpha' });
    expect(resume).toHaveTextContent('Resume placing work');
    expect(screen.getByText('Draining')).toBeInTheDocument();
    expect(await screen.findByText('alpha is draining')).toBeInTheDocument();
  });

  it('offers no drain with a single host', async () => {
    mockApi(['alpha']);
    renderHosts();
    await screen.findByText('alpha');
    expect(screen.queryByRole('button', { name: /^Drain/ })).not.toBeInTheDocument();
    expect(screen.getByText('Placing')).toBeInTheDocument();
  });

  it('shows capacity as a meter and says once why the platform is not placing work', async () => {
    mockApi(['alpha', 'beta'], 'The execution backend is unreachable.');
    renderHosts();
    await screen.findByText('alpha');

    expect(screen.getAllByRole('status', { name: '' })).toHaveLength(1);
    expect(screen.getByText('The execution backend is unreachable.')).toBeInTheDocument();
    expect(screen.getAllByText('Not placing')).toHaveLength(2);
    const meter = screen.getByRole('meter', { name: 'Environments on alpha' });
    expect(meter).toHaveAttribute('aria-valuenow', '2');
    expect(meter).toHaveAttribute('aria-valuemax', '10');
    expect(screen.getAllByText('1.5 of 4 cores')).toHaveLength(2);
  });

  it('shows the error with a retry that reads again', async () => {
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        reads += 1;
        return Promise.resolve(
          reads === 1
            ? json({ error: { code: 'INTERNAL', message: 'Hosts are unavailable.' } }, 500)
            : json({ hosts: [host('alpha')] }),
        );
      }),
    );
    renderHosts();

    expect(await screen.findByText('Hosts are unavailable.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('alpha')).toBeInTheDocument();
  });
});
