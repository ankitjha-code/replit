import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { StatTile } from './StatTile.js';

describe('StatTile', () => {
  it('shows label and value, or a skeleton, or an error with Retry', () => {
    const { rerender } = render(
      <MemoryRouter>
        <StatTile label="Accounts" value={12} to="/operations/accounts" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /Accounts\s*12/ })).toHaveAttribute(
      'href',
      '/operations/accounts',
    );

    rerender(
      <MemoryRouter>
        <StatTile label="Accounts" loading />
      </MemoryRouter>,
    );
    expect(screen.getByText('Accounts').closest('[aria-busy="true"]')).not.toBeNull();

    rerender(
      <MemoryRouter>
        <StatTile label="Accounts" error="Could not load" onRetry={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
