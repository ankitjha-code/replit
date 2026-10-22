import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Progress } from './Progress.js';

describe('Progress', () => {
  it('reports a determinate value', () => {
    render(<Progress value={40} label="Pulling image" />);
    const bar = screen.getByRole('progressbar', { name: 'Pulling image' });
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('is indeterminate without a value', () => {
    render(<Progress label="Building" />);
    const bar = screen.getByRole('progressbar', { name: 'Building' });
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveClass('ui-progress--indeterminate');
  });
});
