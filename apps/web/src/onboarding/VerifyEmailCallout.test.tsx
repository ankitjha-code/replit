import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GettingStarted } from './GettingStarted.js';
import { VerifyEmailCallout } from './VerifyEmailCallout.js';

const user = {
  id: '018f0000-0000-7000-8000-000000000001',
  email: 'ada@example.test',
  username: 'ada',
  displayName: null,
  emailVerified: false,
  isOperator: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const CALLOUT = 'Confirm your email so password resets and alerts can reach you.';

const renderHome = (withChecklist = true) =>
  render(
    <MemoryRouter>
      <VerifyEmailCallout />
      {withChecklist ? <GettingStarted user={user} projects={[]} onCreate={vi.fn()} /> : null}
    </MemoryRouter>,
  );

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe('VerifyEmailCallout', () => {
  it('asks once on the first-run home: the checklist step, not a second callout', () => {
    renderHome();

    expect(screen.getByRole('heading', { name: 'Getting started' })).toBeInTheDocument();
    expect(screen.queryByText(CALLOUT)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Resend link' })).toHaveLength(1);
  });

  it('comes back when the checklist is hidden', async () => {
    renderHome();

    await userEvent.click(screen.getByRole('button', { name: 'Hide' }));

    expect(screen.queryByRole('heading', { name: 'Getting started' })).not.toBeInTheDocument();
    expect(screen.getByText(CALLOUT)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Resend link' })).toHaveLength(1);
  });

  it('shows on its own where there is no checklist', () => {
    renderHome(false);
    expect(screen.getByText(CALLOUT)).toBeInTheDocument();
  });
});
