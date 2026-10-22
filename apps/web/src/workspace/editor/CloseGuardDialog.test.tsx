import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CloseGuardDialog, type CloseGuardReason } from './CloseGuardDialog.js';

function renderDialog(
  overrides: Partial<{
    reason: CloseGuardReason;
    onSaveAndClose: () => Promise<void>;
    onDiscard: () => void;
    onCancel: () => void;
  }> = {},
) {
  const props = {
    onSaveAndClose: vi.fn(() => Promise.resolve()),
    onDiscard: vi.fn(),
    onCancel: vi.fn(),
    reason: 'dirty' as CloseGuardReason,
    ...overrides,
  };
  render(<CloseGuardDialog open fileName="index.js" {...props} />);
  return props;
}

describe('the close guard dialog', () => {
  it('names the file and offers the three answers, with saving first in focus', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Save changes to index.js?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and close' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('saves, then closes, when told to', async () => {
    const user = userEvent.setup();
    const props = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Save and close' }));
    await waitFor(() => expect(props.onSaveAndClose).toHaveBeenCalledTimes(1));
    expect(props.onDiscard).not.toHaveBeenCalled();
  });

  it('stays open and says why when the save fails', async () => {
    const user = userEvent.setup();
    const props = renderDialog({
      onSaveAndClose: vi.fn(() => Promise.reject(new Error('Not allowed'))),
    });
    await user.click(screen.getByRole('button', { name: 'Save and close' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not allowed');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(props.onDiscard).toHaveBeenCalledTimes(1);
  });

  it('discards only through its own button', async () => {
    const user = userEvent.setup();
    const props = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(props.onDiscard).toHaveBeenCalledTimes(1);
    expect(props.onSaveAndClose).not.toHaveBeenCalled();
  });

  it('treats Escape as Cancel', async () => {
    const user = userEvent.setup();
    const props = renderDialog();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(props.onCancel).toHaveBeenCalled());
    expect(props.onDiscard).not.toHaveBeenCalled();
    expect(props.onSaveAndClose).not.toHaveBeenCalled();
  });

  it('does not offer to save a conflicted file, which would conflict again', () => {
    renderDialog({ reason: 'conflict' });
    expect(screen.queryByRole('button', { name: 'Save and close' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(screen.getByRole('dialog')).toHaveTextContent('changed elsewhere');
  });
});
