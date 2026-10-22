import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog.js';

function Harness(props: Partial<ConfirmDialogProps>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Delete
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete project?"
        body="Its files and deployments go with it."
        confirmLabel="Delete project"
        tone="danger"
        onConfirm={() => Promise.resolve()}
        {...props}
      />
    </>
  );
}

describe('ConfirmDialog', () => {
  it('starts on Cancel for danger, confirms, closes and returns focus to the opener', async () => {
    const onConfirm = vi.fn(() => Promise.resolve());
    render(<Harness onConfirm={onConfirm} />);
    const opener = screen.getByRole('button', { name: 'Delete' });
    await userEvent.click(opener);
    await screen.findByRole('alertdialog', { name: 'Delete project?' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());

    await userEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('shows the error with a retry when the action rejects and keeps the dialog open', async () => {
    const onConfirm = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('The server said no'))
      .mockResolvedValueOnce(undefined);
    render(<Harness onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByRole('alertdialog');
    await userEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The server said no');
    await userEvent.click(screen.getByRole('button', { name: 'Retry: Delete project' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('takes its accessible name from ariaLabel even with a title, which stays visible', async () => {
    render(<Harness ariaLabel="Confirm delete" />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm delete' });
    expect(dialog).toHaveTextContent('Delete project?');
  });

  it('enables Confirm only once the typed name matches, and Enter confirms then', async () => {
    const onConfirm = vi.fn(() => Promise.resolve());
    render(<Harness onConfirm={onConfirm} typeToConfirm="hello-world" />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByRole('alertdialog');
    const confirm = screen.getByRole('button', { name: 'Delete project' });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAccessibleDescription('Type hello-world to confirm');

    const input = screen.getByLabelText(/Type .* to confirm/);
    await userEvent.type(input, 'hello{Enter}');
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.type(input, '-world');
    expect(screen.getByRole('button', { name: 'Delete project' })).toBeEnabled();
    await userEvent.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
