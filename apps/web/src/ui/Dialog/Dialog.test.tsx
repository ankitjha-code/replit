import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog.js';

function Harness({ loading = false, error }: { loading?: boolean; error?: string }) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Rename
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Rename project"
        description="The URL changes with it."
        initialFocus={inputRef}
        loading={loading}
        {...(error ? { error, onRetry: () => {} } : {})}
        footer={
          <button type="button" onClick={() => setOpen(false)}>
            Save
          </button>
        }
      >
        <input ref={inputRef} aria-label="Name" />
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('opens as a modal dialog, focuses the requested field, closes on Esc and returns focus', async () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Rename' });
    await userEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Rename project' });
    expect(dialog).toHaveAccessibleDescription('The URL changes with it.');
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('shows a skeleton while loading and an error with Retry', async () => {
    const { rerender } = render(<Harness loading />);
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByLabelText('Name')).toBeNull();

    rerender(<Harness error="Could not load the project" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the project');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
