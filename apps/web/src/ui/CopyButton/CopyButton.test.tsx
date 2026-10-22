import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster, clearToasts } from '../Toast/Toast.js';
import { CopyButton } from './CopyButton.js';

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('CopyButton', () => {
  it('copies the value, confirms for a moment, then returns to its label', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<CopyButton value="https://example.test" label="Copy URL" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
    expect(writeText).toHaveBeenCalledWith('https://example.test');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Copied');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1600));
    });
    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeInTheDocument();
  });

  it('raises a toast when the clipboard is not available', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    vi.stubGlobal('document', Object.assign(document, { execCommand: () => false }));
    render(
      <>
        <Toaster />
        <CopyButton value="secret" label="Copy token" withText />
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Copy token' }));
    expect(await screen.findByText('Could not copy')).toBeInTheDocument();
  });
});
