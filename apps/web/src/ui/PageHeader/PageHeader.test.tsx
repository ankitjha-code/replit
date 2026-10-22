import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../Button/Button.js';
import { PageHeader } from './PageHeader.js';

describe('PageHeader', () => {
  it('has an h1, one sentence, one primary action, two secondary buttons and an overflow menu', async () => {
    const onArchive = vi.fn();
    render(
      <PageHeader
        title="Hello World"
        description="A Node app."
        primaryAction={<Button variant="primary">Deploy</Button>}
        secondaryActions={[
          { label: 'Share', onSelect: () => {} },
          { label: 'Invite', onSelect: () => {} },
          { label: 'Archive', onSelect: onArchive },
        ]}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Hello World' })).toBeInTheDocument();
    expect(screen.getByText('A Node app.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    expect(onArchive).toHaveBeenCalled();
  });

  it('renders a secondary action with a destination as a link that navigates', async () => {
    render(
      <MemoryRouter initialEntries={['/operations']}>
        <Routes>
          <Route
            path="/operations"
            element={
              <PageHeader
                title="Operations"
                secondaryActions={[{ label: 'System status', to: '/status' }]}
              />
            }
          />
          <Route path="/status" element={<h1>System status page</h1>} />
        </Routes>
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'System status' });
    expect(link).toHaveAttribute('href', '/status');
    expect(link).toHaveClass('ui-button', 'ui-button--secondary');

    await userEvent.click(link);
    expect(await screen.findByRole('heading', { name: 'System status page' })).toBeVisible();
  });
});
