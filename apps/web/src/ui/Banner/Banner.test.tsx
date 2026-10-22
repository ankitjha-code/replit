import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Banner } from './Banner.js';

describe('Banner', () => {
  it('announces its message and carries an action', () => {
    render(
      <Banner
        tone="offline"
        message="You are offline. Changes save when you reconnect."
        action={<button type="button">Retry now</button>}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('You are offline');
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeInTheDocument();
  });

  it('is an alert when the tone is danger', () => {
    render(<Banner tone="danger" message="Your session ended." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Your session ended.');
  });
});
