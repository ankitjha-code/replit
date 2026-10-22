import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { RUNTIME_LANGUAGES } from '@platform/shared';
import { Landing } from './Landing.js';

const renderLanding = (props: Parameters<typeof Landing>[0] = {}) =>
  render(
    <MemoryRouter>
      <Landing {...props} />
    </MemoryRouter>,
  );

describe('Landing', () => {
  it('says what the product does and offers one way in', () => {
    renderLanding();

    expect(
      screen.getByRole('heading', { level: 1, name: /Build and run applications in the browser/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/register',
    );
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(screen.queryByRole('link', { name: 'System status' })).toBeNull();
  });

  it('lists every runtime the platform knows, one chip each', () => {
    renderLanding();
    const list = screen.getByRole('list', { name: 'Supported runtimes' });
    expect(list.querySelectorAll('li')).toHaveLength(RUNTIME_LANGUAGES.length);
    expect(screen.getByText('Node.js 22')).toBeInTheDocument();
  });

  it('renders a skeleton in place of the headline while the session is unknown', () => {
    renderLanding({ loading: true });

    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create an account' })).not.toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByRole('list', { name: 'Supported runtimes' })).toBeInTheDocument();
  });

  it('says when the server could not be reached and lets the visitor retry', async () => {
    const onRetry = vi.fn();
    renderLanding({ unreachable: true, onRetry });

    expect(screen.getByRole('status')).toHaveTextContent('The server could not be reached');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Create an account' })).toBeInTheDocument();
  });
});
