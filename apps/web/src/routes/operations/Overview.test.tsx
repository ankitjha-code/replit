import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  json,
  operationsHandlers,
  overview,
  renderOperations,
  routeFetch,
} from './test-helpers.js';

afterEach(() => vi.unstubAllGlobals());

describe('Operations overview', () => {
  it('shows the four numbers with their details and links to the pages behind them', async () => {
    routeFetch(operationsHandlers());
    renderOperations('/operations');

    expect(await screen.findByText('12')).toBeInTheDocument();
    expect(screen.getByText('9 confirmed, 2 operators')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
    expect(screen.getByText('5 live, 1 failed deployments')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('of 30 projects')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('1 running, 2 failed')).toBeInTheDocument();
    const tileLinks = screen.getAllByRole('link').filter((link) => link.closest('.ui-stat-tile'));
    expect(tileLinks.map((link) => link.getAttribute('href'))).toEqual([
      '/operations/accounts',
      '/operations/hosts',
    ]);
    expect(screen.getByText(/^Updated/)).toBeInTheDocument();
    expect(document.title).toBe('Operations · Workspace');
  });

  it('re-reads on Refresh', async () => {
    const calls = routeFetch(operationsHandlers());
    renderOperations('/operations');
    await screen.findByText('12');

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(calls.filter((call) => call === 'GET /api/operations/overview')).toHaveLength(2),
    );
  });

  it('shows the error with a retry that reads again', async () => {
    let reads = 0;
    routeFetch({
      ...operationsHandlers(),
      'GET /api/operations/overview': () => {
        reads += 1;
        return reads === 1
          ? json({ error: { code: 'INTERNAL', message: 'Overview is unavailable.' } }, 500)
          : json(overview());
      },
    });
    renderOperations('/operations');

    expect(await screen.findByText('Overview is unavailable.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('12')).toBeInTheDocument();
  });
});
