import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api-client.js';
import { TwoFactorStep } from './TwoFactorStep.js';

const refused = (details?: unknown) =>
  new ApiError(
    'UNAUTHENTICATED',
    'That code is not right, or the sign-in has expired. Sign in again.',
    401,
    'r',
    details,
  );

describe('TwoFactorStep', () => {
  it('asks for six digits with a numeric keyboard and a one-time-code hint', () => {
    render(<TwoFactorStep onSubmit={vi.fn()} onStartAgain={vi.fn()} />);
    const input = screen.getByLabelText('Code');
    expect(screen.getByRole('heading', { level: 2, name: 'Enter your code' })).toBeInTheDocument();
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
  });

  it('refuses a code that is not six digits before contacting the server', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<TwoFactorStep onSubmit={onSubmit} onStartAgain={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Code'), '12');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the 6-digit code');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sends the digits without the spaces people type between halves', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<TwoFactorStep onSubmit={onSubmit} onStartAgain={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Code'), '123 456');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('123456'));
  });

  it('says a wrong code is wrong and keeps the form, so the user can try again', async () => {
    const onSubmit = vi.fn(() => Promise.reject(refused()));
    render(<TwoFactorStep onSubmit={onSubmit} onStartAgain={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That code is not right. Try again.',
    );
    expect(screen.getByLabelText('Code')).toBeInTheDocument();
  });

  it('passes on the attempts left when the server reports them', async () => {
    const onSubmit = vi.fn(() => Promise.reject(refused({ attemptsRemaining: 2 })));
    render(<TwoFactorStep onSubmit={onSubmit} onStartAgain={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('2 attempts left');
  });

  it('switches to a recovery code and back', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<TwoFactorStep onSubmit={onSubmit} onStartAgain={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
    const recovery = screen.getByLabelText('Recovery code');
    expect(recovery).toHaveAttribute('inputmode', 'text');
    await user.type(recovery, 'abcd-efgh');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('abcd-efgh'));
    await user.click(screen.getByRole('button', { name: 'Use your authenticator app instead' }));
    expect(screen.getByLabelText('Code')).toHaveValue('');
  });

  it('shows the expired notice with a Start again button once the challenge has run out', async () => {
    const onStartAgain = vi.fn();
    render(
      <TwoFactorStep onSubmit={vi.fn()} onStartAgain={onStartAgain} expiresAt={Date.now() - 1} />,
    );
    expect(await screen.findByRole('status')).toHaveTextContent('This sign-in attempt expired');
    expect(screen.queryByLabelText('Code')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start again' }));
    expect(onStartAgain).toHaveBeenCalled();
  });

  it('treats a server-reported expiry the same way', async () => {
    const onSubmit = vi.fn(() => Promise.reject(refused({ reason: 'expired' })));
    render(<TwoFactorStep onSubmit={onSubmit} onStartAgain={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('status')).toHaveTextContent('This sign-in attempt expired');
  });

  it('offers Start again while the form is showing', async () => {
    const onStartAgain = vi.fn();
    render(<TwoFactorStep onSubmit={vi.fn()} onStartAgain={onStartAgain} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start again' }));
    expect(onStartAgain).toHaveBeenCalled();
  });
});
