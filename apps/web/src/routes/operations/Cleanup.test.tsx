import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearToasts } from '../../ui/index.js';
import { describeStep } from './Cleanup.js';
import {
  json,
  operationsHandlers,
  renderOperations,
  routeFetch,
  sweepReport,
} from './test-helpers.js';

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

describe('Operations cleanup', () => {
  it('runs a dry run first and offers to remove what it found only after a confirm', async () => {
    const bodies: unknown[] = [];
    routeFetch({
      ...operationsHandlers(),
      'POST /api/operations/sweep': (init) => {
        const body = JSON.parse(String(init?.body)) as { dryRun: boolean };
        bodies.push(body);
        return json(sweepReport(body.dryRun));
      },
    });
    renderOperations('/operations/cleanup');

    expect(await screen.findByText('No report yet.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Look for orphans' }));

    expect(await screen.findByRole('heading', { level: 3, name: 'Dry run' })).toBeInTheDocument();
    expect(bodies).toEqual([{ dryRun: true }]);
    expect(screen.getByText('5 found, 2 abandoned, nothing removed')).toBeInTheDocument();
    expect(screen.getByText('Not checked: No object store')).toBeInTheDocument();
    expect(screen.getByText('4 sessions, 1 links removed')).toBeInTheDocument();
    expect(screen.getByText(/took 4s/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove 2 items' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove 2 abandoned items?' });
    expect(bodies).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove 2 items' }));

    await waitFor(() => expect(bodies).toEqual([{ dryRun: true }, { dryRun: false }]));
    expect(
      await screen.findByRole('heading', { level: 3, name: 'Cleanup run' }),
    ).toBeInTheDocument();
    expect(screen.getByText('5 found, 2 abandoned, 2 removed')).toBeInTheDocument();
    expect(screen.getAllByText('2 items removed').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
  });

  it('says when there is nothing to remove', async () => {
    routeFetch({
      ...operationsHandlers(),
      'POST /api/operations/sweep': () => json(sweepReport(true, 0)),
    });
    renderOperations('/operations/cleanup');

    await userEvent.click(await screen.findByRole('button', { name: 'Look for orphans' }));
    expect(await screen.findByText('Nothing to remove')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Look again' })).toBeInTheDocument();
  });

  it('shows the error with a retry', async () => {
    let runs = 0;
    routeFetch({
      ...operationsHandlers(),
      'POST /api/operations/sweep': () => {
        runs += 1;
        return runs === 1
          ? json({ error: { code: 'INTERNAL', message: 'The sweeper is busy.' } }, 500)
          : json(sweepReport(true, 0));
      },
    });
    renderOperations('/operations/cleanup');

    await userEvent.click(await screen.findByRole('button', { name: 'Look for orphans' }));
    expect(await screen.findByText('The sweeper is busy.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Nothing to remove')).toBeInTheDocument();
  });

  it('describes a step in plain words', () => {
    const step = { found: 5, orphaned: 2, removed: 0, failed: 0, skipped: null };
    expect(describeStep(step, true)).toBe('5 found, 2 abandoned, nothing removed');
    expect(describeStep({ ...step, removed: 1, failed: 1 }, false)).toBe(
      '5 found, 2 abandoned, 1 removed, 1 could not be removed',
    );
    expect(describeStep({ ...step, skipped: 'No object store' }, true)).toBe(
      'Not checked: No object store',
    );
  });
});
