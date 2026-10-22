import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUOTA_LABELS } from '@platform/shared';
import { AccountUsage } from './AccountUsage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const quotas = (runtimesUsed: number) => ({
  quotas: [
    { kind: 'RUNTIMES', used: runtimesUsed, limit: 3 },
    { kind: 'DEPLOYMENTS', used: 0, limit: 3 },
    { kind: 'BUILDS', used: 0, limit: 2 },
  ],
});

afterEach(() => vi.unstubAllGlobals());

describe('AccountUsage', () => {
  it('shows every limit as a meter, from the first paint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(quotas(1)))),
    );
    render(<AccountUsage />);

    // Labelled loading bars before the answer arrives: the card never starts empty.
    expect(screen.getByText('Environments running')).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();

    await waitFor(() =>
      expect(screen.getByRole('meter', { name: 'Environments running' })).toHaveAttribute(
        'aria-valuetext',
        '1 of 3',
      ),
    );
    expect(screen.getByRole('meter', { name: QUOTA_LABELS.DEPLOYMENTS })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says what to do when a limit is reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(quotas(3)))),
    );
    render(<AccountUsage />);

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Stop an environment to free a slot.',
    );
  });

  it('says when usage could not be read, and reads again on Retry', async () => {
    let failing = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          failing
            ? json({ error: { code: 'INTERNAL_ERROR', message: 'boom', requestId: 'r' } }, 500)
            : json(quotas(2)),
        ),
      ),
    );
    render(<AccountUsage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read your usage.');
    failing = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() =>
      expect(screen.getByRole('meter', { name: 'Environments running' })).toHaveAttribute(
        'aria-valuetext',
        '2 of 3',
      ),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
