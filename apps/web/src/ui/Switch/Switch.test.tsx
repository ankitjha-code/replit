import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Switch } from './Switch.js';

describe('Switch', () => {
  it('is a switch with a visible label that toggles on click and Space', async () => {
    const onCheckedChange = vi.fn();
    render(<Switch label="Follow output" checked={false} onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole('switch', { name: 'Follow output' });
    expect(control).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(control);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('shows the new value at once and reverts when the save rejects', async () => {
    let reject: (error: Error) => void = () => {};
    const onCheckedChange = vi.fn(
      () =>
        new Promise<void>((_, rej) => {
          reject = rej;
        }),
    );
    render(<Switch label="Alerts" checked={false} onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole('switch', { name: 'Alerts' });
    await userEvent.click(control);
    expect(control).toHaveAttribute('aria-checked', 'true');
    expect(control).toHaveAttribute('aria-busy', 'true');
    await act(async () => {
      reject(new Error('Forbidden'));
    });
    expect(control).toHaveAttribute('aria-checked', 'false');
  });

  it('is disabled with a reason', () => {
    render(<Switch label="Keep measuring" disabledReason="Monitoring is off" />);
    const control = screen.getByRole('switch', { name: 'Keep measuring' });
    expect(control).toBeDisabled();
    expect(control).toHaveAccessibleDescription('Monitoring is off');
  });
});
