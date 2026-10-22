import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Breadcrumb } from './Breadcrumb.js';

describe('Breadcrumb', () => {
  it('links every item but the current page, which is aria-current', () => {
    render(
      <MemoryRouter>
        <Breadcrumb
          items={[
            { label: 'Projects', to: '/' },
            { loading: true },
            { label: 'Settings', to: '/settings' },
          ]}
        />
      </MemoryRouter>,
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(screen.getByText('Settings')).toHaveAttribute('aria-current', 'page');
    expect(nav.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});
