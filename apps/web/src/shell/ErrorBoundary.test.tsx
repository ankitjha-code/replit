import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary.js';

function Broken(): never {
  throw new Error('render exploded');
}

describe('ErrorBoundary', () => {
  let quiet: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => quiet.mockRestore());

  it('renders its children while nothing is wrong', () => {
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('fine')).toBeInTheDocument();
  });

  it('shows a page-size fallback with the ways out when a child throws', () => {
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );
    expect(
      screen.getByRole('heading', { name: 'Something went wrong on this page', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to projects' })).toHaveAttribute('href', '/');
  });

  it('forgets the error when the reset key changes', () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/broken">
        <Broken />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    rerender(
      <ErrorBoundary resetKey="/fine">
        <p>recovered</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });
});
