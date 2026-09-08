import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountLimits } from './OperationsPage.js';

const ACCOUNT = '018f0000-0000-7000-8000-000000000002';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const quotas = (runtimes: number | null) => ({
  quotas: [
    {
      kind: 'RUNTIMES',
      used: 1,
      limit: runtimes ?? 3,
      defaultLimit: 3,
      overridden: runtimes !== null,
    },
    { kind: 'DEPLOYMENTS', used: 0, limit: 2, defaultLimit: 2, overridden: false },
    { kind: 'BUILDS', used: 0, limit: 1, defaultLimit: 1, overridden: false },
  ],
});

function mockApi(initial: number | null) {
  const puts: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { limit: number | null };
        puts.push(body);
        return Promise.resolve(json(quotas(body.limit)));
      }
      return Promise.resolve(json(quotas(initial)));
    }),
  );
  return { puts };
}

afterEach(() => vi.unstubAllGlobals());

describe('an account’s limits', () => {
  it('sets an exception and shows the default beside it', async () => {
    const { puts } = mockApi(null);
    render(<AccountLimits accountId={ACCOUNT} />);

    const field = await screen.findByLabelText('Environments running');
    await userEvent.clear(field);
    await userEvent.type(field, '8');
    await userEvent.click(screen.getAllByRole('button', { name: 'Set' })[0]!);

    await waitFor(() => expect(puts).toEqual([{ kind: 'RUNTIMES', limit: 8 }]));
    expect(await screen.findByText(/default is 3/)).toBeInTheDocument();
  });

  it('puts an account back on the default by removing the exception', async () => {
    const { puts } = mockApi(8);
    render(<AccountLimits accountId={ACCOUNT} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Use default' }));

    await waitFor(() => expect(puts).toEqual([{ kind: 'RUNTIMES', limit: null }]));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Use default' })).not.toBeInTheDocument(),
    );
  });
});
