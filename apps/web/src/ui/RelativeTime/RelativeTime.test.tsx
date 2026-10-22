import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelativeTime } from './RelativeTime.js';

describe('RelativeTime', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('renders words in the row and the absolute time in the title and tooltip', async () => {
    const now = new Date('2026-09-30T12:00:00Z');
    vi.setSystemTime(now);
    const value = new Date(now.getTime() - 3 * 60_000).toISOString();
    render(<RelativeTime value={value} prefix="Updated" />);
    const time = screen.getByText('Updated 3 min ago');
    expect(time).toHaveAttribute('datetime', value);
    expect(time.getAttribute('title')).toMatch(/2026/);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.hover(time);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/2026/);
  });
});
