import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearToasts } from '../../ui/index.js';
import {
  OTHER_ID,
  account,
  json,
  operationsHandlers,
  operator,
  quotas,
  renderOperations,
  routeFetch,
} from './test-helpers.js';

const self = account({
  id: operator.id,
  username: operator.username,
  email: operator.email,
  isOperator: true,
  projects: 1,
});

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

describe('Operations accounts', () => {
  it('lists accounts with their badges and never offers to change your own operator access', async () => {
    routeFetch({
      ...operationsHandlers(),
      'GET /api/operations/accounts': () =>
        json({ accounts: [self, account({ emailVerified: false })], nextCursor: null }),
    });
    renderOperations('/operations/accounts');

    expect(await screen.findByText('grace')).toBeInTheDocument();
    expect(screen.getByText('Operator')).toBeInTheDocument();
    expect(screen.getByText('Not confirmed')).toBeInTheDocument();
    expect(screen.getByText('3 projects')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make grace an operator' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove operator from ada' })).toBeDisabled();
    expect(screen.getByText('2 shown')).toBeInTheDocument();
  });

  it('makes an operator after a confirm and re-reads the list', async () => {
    let reads = 0;
    const calls = routeFetch({
      ...operationsHandlers(),
      'GET /api/operations/accounts': () => {
        reads += 1;
        return json({ accounts: [account({ isOperator: reads > 1 })], nextCursor: null });
      },
      [`PUT /api/operations/accounts/${OTHER_ID}/operator`]: () =>
        new Response(null, { status: 204 }),
    });
    renderOperations('/operations/accounts');

    await userEvent.click(await screen.findByRole('button', { name: 'Make grace an operator' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Make grace an operator?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Make grace an operator' }));

    await waitFor(() =>
      expect(calls).toContain(`PUT /api/operations/accounts/${OTHER_ID}/operator`),
    );
    expect(await screen.findByText('grace is now an operator')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Remove operator from grace' }),
    ).toBeInTheDocument();
  });

  it('appends the next page, searches what is loaded, and expands limits inline', async () => {
    // The longer keys go first: routeFetch takes the first key the URL contains.
    const calls = routeFetch({
      'GET /api/operations/accounts?after=c1': () =>
        json({
          accounts: [account({ id: 'id-3', username: 'linus', email: 'linus@example.test' })],
          nextCursor: null,
        }),
      [`GET /api/operations/accounts/${OTHER_ID}/quotas`]: () => json(quotas(null)),
      ...operationsHandlers(),
      'GET /api/operations/accounts': () => json({ accounts: [account()], nextCursor: 'c1' }),
    });
    renderOperations('/operations/accounts');

    await screen.findByText('grace');
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('linus')).toBeInTheDocument();
    expect(screen.getByText('grace')).toBeInTheDocument();
    expect(calls).toContain('GET /api/operations/accounts?after=c1');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();

    await userEvent.type(screen.getByRole('searchbox', { name: 'Search accounts' }), 'lin');
    expect(screen.queryByText('grace')).toBeNull();
    expect(screen.getByText('linus')).toBeInTheDocument();
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search accounts' }));

    const limits = screen.getByRole('button', { name: 'Edit limits for grace' });
    expect(limits).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(limits);
    expect(limits).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByLabelText('Environments running')).toHaveValue(3);
  });

  it('shows the error with a retry', async () => {
    let reads = 0;
    routeFetch({
      ...operationsHandlers(),
      'GET /api/operations/accounts': () => {
        reads += 1;
        return reads === 1
          ? json({ error: { code: 'INTERNAL', message: 'Accounts are unavailable.' } }, 500)
          : json({ accounts: [account()], nextCursor: null });
      },
    });
    renderOperations('/operations/accounts');

    expect(await screen.findByText('Accounts are unavailable.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('grace')).toBeInTheDocument();
  });
});
