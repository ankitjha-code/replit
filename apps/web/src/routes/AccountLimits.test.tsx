import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiProvider, clearToasts } from '../ui/index.js';
import { AccountLimits } from './OperationsPage.js';
import { parseLimit } from './operations/AccountLimits.js';
import { json, quotas } from './operations/test-helpers.js';

const ACCOUNT = '018f0000-0000-7000-8000-000000000002';

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

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

const renderLimits = () =>
  render(
    <UiProvider>
      <AccountLimits accountId={ACCOUNT} />
    </UiProvider>,
  );

describe('an account’s limits', () => {
  it('sets an exception and shows the default beside it', async () => {
    const { puts } = mockApi(null);
    renderLimits();

    const field = await screen.findByLabelText('Environments running');
    expect(screen.getByText(/Using 1 \(default\)/)).toBeInTheDocument();
    await userEvent.clear(field);
    await userEvent.type(field, '8');
    await userEvent.click(screen.getAllByRole('button', { name: 'Set' })[0]!);

    await waitFor(() => expect(puts).toEqual([{ kind: 'RUNTIMES', limit: 8 }]));
    expect(await screen.findByText(/default is 3/)).toBeInTheDocument();
    expect(await screen.findByText('Environments running set to 8')).toBeInTheDocument();
  });

  it('puts an account back on the default by removing the exception', async () => {
    const { puts } = mockApi(8);
    renderLimits();

    await userEvent.click(await screen.findByRole('button', { name: 'Use default' }));

    await waitFor(() => expect(puts).toEqual([{ kind: 'RUNTIMES', limit: null }]));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Use default' })).not.toBeInTheDocument(),
    );
  });

  it('keeps Set disabled until the value changes and refuses an empty value', async () => {
    const { puts } = mockApi(null);
    renderLimits();

    const field = await screen.findByLabelText('Environments running');
    expect(screen.getAllByRole('button', { name: 'Set' })[0]).toBeDisabled();
    expect(screen.getAllByText('Nothing changed').length).toBeGreaterThan(0);

    await userEvent.clear(field);
    const set = screen.getAllByRole('button', { name: 'Set' })[0]!;
    expect(set).toBeEnabled();
    await userEvent.click(set);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a whole number from 1 to 200.',
    );
    expect(puts).toEqual([]);
  });

  it('marks a limit that is fully used', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          json({
            quotas: [{ kind: 'RUNTIMES', used: 3, limit: 3, defaultLimit: 3, overridden: false }],
          }),
        ),
      ),
    );
    renderLimits();
    expect(await screen.findByText('At limit')).toBeInTheDocument();
  });

  it('parses only whole numbers inside the allowed range', () => {
    expect(parseLimit('')).toBeUndefined();
    expect(parseLimit('  ')).toBeUndefined();
    expect(parseLimit('0')).toBeUndefined();
    expect(parseLimit('201')).toBeUndefined();
    expect(parseLimit('2.5')).toBeUndefined();
    expect(parseLimit('abc')).toBeUndefined();
    expect(parseLimit('1')).toBe(1);
    expect(parseLimit('200')).toBe(200);
  });
});
