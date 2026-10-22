import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster, clearToasts } from '../Toast/Toast.js';
import { Select } from './Select.js';

const options = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'editor', label: 'Editor' },
];

afterEach(() => clearToasts());

describe('Select', () => {
  it('is a native select that selectOptions can drive', async () => {
    const onChange = vi.fn();
    render(
      <Select aria-label="Works for" options={options} defaultValue="viewer" onChange={onChange} />,
    );
    await userEvent.selectOptions(screen.getByLabelText('Works for'), 'editor');
    expect(onChange).toHaveBeenCalled();
    expect(screen.getByLabelText('Works for')).toHaveValue('editor');
  });

  it('reverts and raises a toast when the change is rejected', async () => {
    let reject: (error: Error) => void = () => {};
    const onValueChange = vi.fn(
      () =>
        new Promise<void>((_, rej) => {
          reject = rej;
        }),
    );
    render(
      <>
        <Toaster />
        <Select aria-label="Role" options={options} value="viewer" onValueChange={onValueChange} />
      </>,
    );
    const select = screen.getByLabelText('Role');
    await userEvent.selectOptions(select, 'editor');
    expect(select).toHaveValue('editor');
    expect(select).toHaveAttribute('aria-busy', 'true');
    await act(async () => {
      reject(new Error('Forbidden'));
    });
    expect(select).toHaveValue('viewer');
    expect(select).not.toHaveAttribute('aria-busy');
    expect(screen.getByText('Forbidden')).toBeInTheDocument();
  });

  it('is disabled with a reason', () => {
    render(
      <Select aria-label="Role" options={options} disabledReason="Owners cannot change role" />,
    );
    const select = screen.getByLabelText('Role');
    expect(select).toBeDisabled();
    expect(select).toHaveAccessibleDescription('Owners cannot change role');
  });
});
