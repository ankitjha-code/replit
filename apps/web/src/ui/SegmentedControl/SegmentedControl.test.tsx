import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Moon, Sun } from '../icons.js';
import { SegmentedControl } from './SegmentedControl.js';

describe('SegmentedControl', () => {
  it('keeps one item pressed and reports changes', async () => {
    const onValueChange = vi.fn();
    render(
      <SegmentedControl
        label="Theme"
        value="dark"
        onValueChange={onValueChange}
        items={[
          { value: 'dark', label: 'Dark', icon: Moon },
          { value: 'light', label: 'Light', icon: Sun, iconOnly: true },
        ]}
      />,
    );
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    const dark = screen.getByRole('radio', { name: 'Dark' });
    expect(dark).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(dark);
    expect(onValueChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(onValueChange).toHaveBeenCalledWith('light');
  });
});
