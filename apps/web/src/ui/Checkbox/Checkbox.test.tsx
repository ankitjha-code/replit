import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox } from './Checkbox.js';

describe('Checkbox', () => {
  it('is a native checkbox found by its label, described by its description', async () => {
    const onChange = vi.fn();
    render(
      <Checkbox label="Email me" description="Once a day at most" onCheckedChange={onChange} />,
    );
    const box = screen.getByLabelText('Email me');
    expect(box).toHaveAttribute('type', 'checkbox');
    expect(box).toHaveAccessibleDescription('Once a day at most');
    await userEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('supports the mixed state and a disabled reason', () => {
    render(<Checkbox label="All" indeterminate disabledReason="Nothing to select" />);
    const box = screen.getByLabelText('All') as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    expect(box).toBeDisabled();
    expect(box).toHaveAccessibleDescription('Nothing to select');
  });

  it('reverts when the change is rejected', async () => {
    const onCheckedChange = vi.fn(() => Promise.reject(new Error('Offline')));
    render(<Checkbox label="Alerts" checked={false} onCheckedChange={onCheckedChange} />);
    await act(async () => {
      await userEvent.click(screen.getByLabelText('Alerts'));
    });
    expect(screen.getByLabelText('Alerts')).not.toBeChecked();
  });
});
