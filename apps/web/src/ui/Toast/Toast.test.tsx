import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster, clearToasts, dismissToast, toast } from './Toast.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  clearToasts();
  vi.useRealTimers();
});

describe('Toast', () => {
  it('dismisses a success toast after 5s and keeps a danger toast', () => {
    render(<Toaster />);
    act(() => {
      toast({ tone: 'success', title: 'Saved' });
      toast({ tone: 'danger', title: 'Save failed', description: 'The server said no.' });
    });
    expect(screen.getByText('Saved').closest('li')).toHaveAttribute('role', 'status');
    expect(screen.getByText('Save failed').closest('li')).toHaveAttribute('role', 'alert');

    act(() => {
      vi.advanceTimersByTime(5400);
    });
    expect(screen.queryByText('Saved')).toBeNull();
    expect(screen.getByText('Save failed')).toBeInTheDocument();
  });

  it('shows at most three toasts and queues the rest', () => {
    render(<Toaster />);
    let first = '';
    act(() => {
      first = toast({ title: 'One' });
      toast({ title: 'Two' });
      toast({ title: 'Three' });
      toast({ title: 'Four' });
    });
    expect(screen.queryByText('Four')).toBeNull();
    act(() => {
      dismissToast(first);
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByText('Four')).toBeInTheDocument();
  });

  it('runs the action, which also dismisses, and dismisses from the close button', () => {
    const onClick = vi.fn();
    render(<Toaster />);
    act(() => {
      toast({ title: 'Copied', action: { label: 'Undo', onClick } });
    });
    act(() => {
      screen.getByRole('button', { name: 'Undo' }).click();
      vi.advanceTimersByTime(400);
    });
    expect(onClick).toHaveBeenCalled();
    expect(screen.queryByText('Copied')).toBeNull();

    act(() => {
      toast({ title: 'Deployed' });
    });
    act(() => {
      screen.getByRole('button', { name: 'Dismiss' }).click();
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByText('Deployed')).toBeNull();
  });
});
