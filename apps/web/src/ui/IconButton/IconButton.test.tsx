import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { X } from '../icons.js';
import { IconButton } from './IconButton.js';

describe('IconButton', () => {
  it('names itself by aria-label and shows the label with its shortcut as a tooltip', async () => {
    render(<IconButton label="Close" icon={X} shortcut={['Escape']} />);
    const button = screen.getByRole('button', { name: 'Close' });
    await userEvent.hover(button);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Close');
    expect(tooltip).toHaveTextContent('Esc');
  });

  it('shows the disabled reason instead of the label tooltip when disabled', async () => {
    render(<IconButton label="Delete file" icon={X} disabledReason="Read-only access" />);
    expect(screen.getByRole('button', { name: 'Delete file' })).toBeDisabled();
    await userEvent.tab();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Read-only access');
  });
});
