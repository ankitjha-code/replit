import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusDot } from './StatusDot.js';

describe('StatusDot', () => {
  it('is named after what its colour means and can pulse', () => {
    render(<StatusDot tone="warn" pulse label="Starting" />);
    const dot = screen.getByRole('img', { name: 'Starting' });
    expect(dot).toHaveClass('ui-status-dot--warn', 'ui-status-dot--pulse');
  });
});
