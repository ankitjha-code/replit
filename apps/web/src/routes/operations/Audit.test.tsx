import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeEntry } from './Audit.js';
import { json, operationsHandlers, renderOperations, routeFetch } from './test-helpers.js';

const entry = (action: string, detail: unknown = null, target: string | null = null) => ({
  id: `${action}-${target ?? ''}`,
  actor: 'ada',
  action,
  target,
  detail,
  at: '2026-01-05T12:00:00.000Z',
});

afterEach(() => vi.unstubAllGlobals());

describe('Operations audit trail', () => {
  it('lists each action as a sentence with its time and expandable details', async () => {
    routeFetch({
      ...operationsHandlers(),
      'GET /api/operations/audit': () =>
        json({
          entries: [
            entry('operator.grant', null, 'grace'),
            entry('host.drain', { host: 'alpha' }),
            entry('quota.override', { kind: 'RUNTIMES', limit: 8 }, 'grace'),
          ],
        }),
    });
    renderOperations('/operations/audit');

    await screen.findByText('grace was made an operator by ada');
    const table = screen.getByRole('table', { name: 'Operator actions' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('grace was made an operator by ada')).toBeInTheDocument();
    expect(rows[0]!.querySelector('time')).toHaveAttribute('dateTime', '2026-01-05T12:00:00.000Z');
    expect(within(rows[0]!).queryByText('Details')).toBeNull();
    expect(within(rows[1]!).getByText('ada drained alpha')).toBeInTheDocument();
    expect(
      within(rows[2]!).getByText('ada set Environments running for grace to 8'),
    ).toBeInTheDocument();

    const details = within(rows[1]!).getByText('Details');
    await userEvent.click(details);
    expect(within(rows[1]!).getByText(/"host": "alpha"/)).toBeInTheDocument();
    expect(document.title).toBe('Audit · Operations · Workspace');
  });

  it('shows an empty state when nothing has been done yet', async () => {
    routeFetch(operationsHandlers());
    renderOperations('/operations/audit');
    expect(await screen.findByText('No operator actions yet.')).toBeInTheDocument();
  });

  it('shows the error with a retry', async () => {
    let reads = 0;
    routeFetch({
      ...operationsHandlers(),
      'GET /api/operations/audit': () => {
        reads += 1;
        return reads === 1
          ? json({ error: { code: 'INTERNAL', message: 'The trail is unavailable.' } }, 500)
          : json({ entries: [entry('sweep.run', { dryRun: true })] });
      },
    });
    renderOperations('/operations/audit');

    expect(await screen.findByText('The trail is unavailable.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('ada ran a cleanup dry run')).toBeInTheDocument();
  });

  it('falls back to the raw action for one it does not know', () => {
    expect(describeEntry(entry('something.new', null, 'grace'))).toBe('ada: something.new (grace)');
    expect(describeEntry(entry('host.undrain', { host: 'beta' }))).toBe(
      'ada resumed placing work on beta',
    );
    expect(describeEntry(entry('quota.reset', { kind: 'BUILDS' }, 'grace'))).toBe(
      'ada put Builds in progress for grace back on the default',
    );
    expect(describeEntry(entry('operator.revoke', null, 'grace'))).toBe(
      'grace was removed as an operator by ada',
    );
  });
});
