import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from '../Button/Button.js';
import { Popover } from './Popover.js';

describe('Popover', () => {
  it('opens from the trigger, closes on Esc and returns focus', async () => {
    render(
      <Popover trigger={<Button>Details</Button>} title="Environment">
        <p>node 22</p>
      </Popover>,
    );
    const trigger = screen.getByRole('button', { name: 'Details' });
    await userEvent.click(trigger);
    expect(await screen.findByRole('dialog', { name: 'Environment' })).toHaveTextContent('node 22');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('shows a skeleton while loading and an error with Retry', async () => {
    const { rerender } = render(
      <Popover trigger={<Button>Details</Button>} label="Environment" loading open>
        <p>node 22</p>
      </Popover>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Environment' });
    expect(dialog.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText('node 22')).toBeNull();
    rerender(
      <Popover
        trigger={<Button>Details</Button>}
        label="Environment"
        error="Could not load"
        onRetry={() => {}}
        open
      >
        <p>node 22</p>
      </Popover>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
