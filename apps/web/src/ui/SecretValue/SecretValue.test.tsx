import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SecretValue } from './SecretValue.js';

describe('SecretValue', () => {
  it('keeps the value out of the DOM until revealed', async () => {
    const { container } = render(<SecretValue value="hunter2" name="password" copy />);
    expect(container.textContent).not.toContain('hunter2');
    expect(screen.getByLabelText('Value is hidden')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(screen.getByText('hunter2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide password' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy password' })).toBeInTheDocument();
  });

  it('can be shown without a toggle for values the server never returns', () => {
    render(<SecretValue value="" revealable={false} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByLabelText('Value is hidden')).toBeInTheDocument();
  });
});
