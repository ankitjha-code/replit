import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Spinner } from './Spinner.js';

describe('Spinner', () => {
  it('is a status with a label for assistive technology', () => {
    render(<Spinner label="Starting the environment" />);
    expect(screen.getByRole('status')).toHaveTextContent('Starting the environment');
  });

  it('shows the label beside the glyph when asked', () => {
    render(<Spinner label="Deploying" labelVisible />);
    expect(screen.getByText('Deploying')).not.toHaveClass('ui-spinner__label--hidden');
  });

  it('is silent when decorative', () => {
    render(<Spinner aria-hidden="true" />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
