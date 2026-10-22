import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DETECTION_HINT,
  LanguagePickerDialog,
  forgetLanguage,
  readRememberedLanguage,
  rememberLanguage,
} from './LanguagePickerDialog.js';

/** Asked once when nothing can be detected (design spec 9.3). */

beforeEach(() => window.localStorage.clear());

describe('LanguagePickerDialog', () => {
  it('lists every runtime, explains detection and starts with the chosen one', async () => {
    const onStart = vi.fn(() => Promise.resolve());
    const onOpenChange = vi.fn();
    render(<LanguagePickerDialog open onOpenChange={onOpenChange} onStart={onStart} />);

    const dialog = screen.getByRole('dialog', { name: 'What does this project run?' });
    expect(dialog).toHaveTextContent(DETECTION_HINT);
    for (const name of ['Node.js', 'Python', 'Go', 'Ruby', 'Static site']) {
      expect(screen.getByRole('radio', { name: new RegExp(name) })).toBeInTheDocument();
    }
    // Node.js is the default, so the primary already names it.
    expect(screen.getByRole('button', { name: 'Start with Node.js' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: /Go/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Start with Go' }));

    expect(onStart).toHaveBeenCalledWith('go');
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('stays open and keeps the choice when starting fails', async () => {
    const onStart = vi.fn(() => Promise.reject(new Error('refused')));
    const onOpenChange = vi.fn();
    render(<LanguagePickerDialog open onOpenChange={onOpenChange} onStart={onStart} />);

    await userEvent.click(screen.getByRole('radio', { name: /Python/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Start with Python' })).catch(() => {
      // The rejection surfaces through the caller's own error state.
    });

    await waitFor(() => expect(onStart).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole('radio', { name: /Python/ })).toBeChecked();
  });

  it('cannot be dismissed while the start is in flight', async () => {
    let finish: () => void = () => undefined;
    const onStart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onOpenChange = vi.fn();
    render(<LanguagePickerDialog open onOpenChange={onOpenChange} onStart={onStart} />);

    await userEvent.click(screen.getByRole('button', { name: 'Start with Node.js' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    finish();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});

describe('the remembered language', () => {
  it('round-trips per project and forgets on request', () => {
    rememberLanguage('p1', 'ruby');
    expect(readRememberedLanguage('p1')).toBe('ruby');
    expect(readRememberedLanguage('p2')).toBeUndefined();
    forgetLanguage('p1');
    expect(readRememberedLanguage('p1')).toBeUndefined();
  });

  it('ignores a stored value that is not a known language', () => {
    window.localStorage.setItem('workspace.language.p1', 'cobol');
    expect(readRememberedLanguage('p1')).toBeUndefined();
  });
});
