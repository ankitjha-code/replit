import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Link } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Play } from '../icons.js';
import { Button } from './Button.js';

afterEach(() => vi.restoreAllMocks());

describe('Button', () => {
  it('is a plain button by default and calls onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('type', 'button');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps its label, ignores clicks and locks its width while loading', async () => {
    const onClick = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(96);
    const { rerender } = render(
      <Button icon={Play} onClick={onClick}>
        Start
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Start' });
    rerender(
      <Button icon={Play} loading loadingLabel="Starting" onClick={onClick}>
        Start
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Start' })).toBe(button);
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveStyle({ minWidth: '96px' });
    expect(button).toHaveAccessibleDescription('Starting');
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();

    rerender(<Button icon={Play}>Start</Button>);
    expect(button.style.minWidth).toBe('');
  });

  it('renders a disabled reason that keyboard users can reach', async () => {
    render(<Button disabledReason="Start the environment first">Run</Button>);
    const button = screen.getByRole('button', { name: 'Run' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Start the environment first');

    await userEvent.tab();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Start the environment first');
  });

  it('dresses a link as a button with asChild', () => {
    render(
      <MemoryRouter>
        <Button asChild variant="primary" icon={Play}>
          <Link to="/projects">Projects</Link>
        </Button>
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Projects' });
    expect(link).toHaveClass('ui-button', 'ui-button--primary');
    expect(link).toHaveAttribute('href', '/projects');
  });

  it('keeps the same element while a reason comes and goes, when asked to', () => {
    const { rerender } = render(<Button keepReasonWrapper>Run</Button>);
    const button = screen.getByRole('button', { name: 'Run' });
    expect(button).toBeEnabled();

    rerender(
      <Button keepReasonWrapper disabledReason="Start the environment first">
        Run
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Run' })).toBe(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Start the environment first');

    rerender(<Button keepReasonWrapper>Run</Button>);
    expect(screen.getByRole('button', { name: 'Run' })).toBe(button);
    expect(button).toBeEnabled();
    // The idle wrapper is not a tab stop of its own.
    expect(button.parentElement).not.toHaveAttribute('tabindex');
  });

  it('adds no wrapper around a button that never has a reason', () => {
    const { container } = render(
      <div>
        <Button>Save</Button>
      </div>,
    );
    expect(container.firstElementChild?.firstElementChild).toHaveClass('ui-button');
  });
});
