import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Input } from './Input.js';

describe('Input', () => {
  it('marks itself invalid and carries leading and trailing content', () => {
    render(
      <Input
        aria-label="Slug"
        invalid
        mono
        leading={<span>/</span>}
        trailing={<span>.app</span>}
        defaultValue="hello"
      />,
    );
    const input = screen.getByLabelText('Slug');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.parentElement).toHaveClass('ui-input-wrap--invalid', 'ui-input-wrap--mono');
    expect(screen.getByText('/')).toBeInTheDocument();
    expect(screen.getByText('.app')).toBeInTheDocument();
  });

  it('explains why it is disabled', async () => {
    render(<Input aria-label="Name" disabledReason="Only the owner can rename" />);
    const input = screen.getByLabelText('Name');
    expect(input).toBeDisabled();
    expect(input).toHaveAccessibleDescription('Only the owner can rename');
    await userEvent.tab();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Only the owner can rename');
  });
});
