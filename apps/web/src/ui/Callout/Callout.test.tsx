import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Callout } from './Callout.js';

describe('Callout', () => {
  it('is an alert for danger and a status otherwise, with an action and a dismiss', async () => {
    const onDismiss = vi.fn();
    render(
      <>
        <Callout tone="danger" title="Save failed" action={<button type="button">Retry</button>}>
          The server did not answer.
        </Callout>
        <Callout tone="info" onDismiss={onDismiss}>
          Deployments are not configured on this installation.
        </Callout>
      </>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Save failed');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('not configured');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
