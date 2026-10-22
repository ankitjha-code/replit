import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FolderSimple } from '../icons.js';
import { EmptyState } from './EmptyState.js';

describe('EmptyState', () => {
  it('has an icon, a sentence and the action', () => {
    const { container } = render(
      <EmptyState
        icon={FolderSimple}
        title="No files yet"
        body="Create a file and it appears here."
        action={<button type="button">New file</button>}
      />,
    );
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('No files yet')).toBeInTheDocument();
    expect(screen.getByText('Create a file and it appears here.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New file' })).toBeInTheDocument();
  });
});
