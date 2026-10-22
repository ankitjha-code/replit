import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GettingStarted } from './GettingStarted.js';
import { resetResendCooldown } from './use-resend-verification.js';

const user = {
  id: '018f0000-0000-7000-8000-000000000001',
  email: 'ada@example.test',
  username: 'ada',
  displayName: null,
  emailVerified: false,
  isOperator: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const project = (overrides: Record<string, unknown> = {}) => ({
  id: '018f0000-0000-7000-8000-0000000000aa',
  slug: 'engine',
  name: 'Engine',
  description: null,
  role: 'OWNER' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const runState = (overrides: Record<string, unknown> = {}) => ({
  status: 'IDLE',
  command: null,
  configuredCommand: null,
  suggestion: null,
  startedAt: null,
  exitedAt: null,
  exitCode: null,
  message: null,
  blockedReason: null,
  ...overrides,
});

const startedEvent = {
  id: 'e1',
  from: null,
  to: 'STARTING',
  reason: null,
  at: '2026-01-01T00:01:00.000Z',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function routeFetch(handlers: Record<string, () => Response>) {
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const match = Object.keys(handlers).find((k) => key.endsWith(k));
    if (!match) throw new Error(`unexpected request: ${key}`);
    return Promise.resolve(handlers[match]!());
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const renderChecklist = (
  projects: ReturnType<typeof project>[],
  options: { onCreate?: () => void; emailVerified?: boolean } = {},
) =>
  render(
    <MemoryRouter>
      <GettingStarted
        user={{ ...user, emailVerified: options.emailVerified ?? false }}
        projects={projects}
        onCreate={options.onCreate ?? vi.fn()}
      />
    </MemoryRouter>,
  );

const meter = () => screen.getByRole('meter', { name: 'Steps done' });

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetResendCooldown();
});

describe('GettingStarted', () => {
  it('lists the five steps for an empty account and offers to pick a starter', async () => {
    routeFetch({});
    const onCreate = vi.fn();
    renderChecklist([], { onCreate });

    expect(screen.getByRole('heading', { name: 'Getting started' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(meter()).toHaveAttribute('aria-valuetext', '0 of 5');
    expect(screen.getByText('Create a project')).toBeInTheDocument();
    expect(screen.getByText('Confirm your email')).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Pick a starter' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('ticks Start and Run from the newest project environment history and run state', async () => {
    routeFetch({
      '/runtime/events': () => json({ events: [startedEvent] }),
      '/run': () =>
        json(
          runState({
            status: 'RUNNING',
            command: 'npm start',
            startedAt: '2026-01-01T00:02:00.000Z',
          }),
        ),
    });
    renderChecklist([project()]);

    await waitFor(() => expect(meter()).toHaveAttribute('aria-valuetext', '3 of 5'));
    const done = screen
      .getAllByRole('listitem')
      .filter((item) => item.getAttribute('data-done') === 'true')
      .map((item) => item.textContent);
    expect(done.join(' ')).toMatch(/Create a project/);
    expect(done.join(' ')).toMatch(/Start its environment/);
    expect(done.join(' ')).toMatch(/Run the app/);
    expect(screen.getByRole('link', { name: 'Open the preview' })).toHaveAttribute(
      'href',
      '/projects/018f0000-0000-7000-8000-0000000000aa',
    );
  });

  it('points Start at the newest project when the environment has never run', async () => {
    routeFetch({
      '/runtime/events': () => json({ events: [] }),
      '/run': () => json(runState()),
    });
    renderChecklist([
      project({ id: 'older', name: 'Older', createdAt: '2025-12-01T00:00:00.000Z' }),
      project({ id: 'newer', name: 'Newer', createdAt: '2026-02-01T00:00:00.000Z' }),
    ]);

    expect(await screen.findByRole('link', { name: 'Open the workspace' })).toHaveAttribute(
      'href',
      '/projects/newer',
    );
    expect(meter()).toHaveAttribute('aria-valuetext', '1 of 5');
  });

  it('says when progress could not be read and offers to try again', async () => {
    let failing = true;
    routeFetch({
      '/runtime/events': () =>
        failing
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'boom', requestId: 'r' } }, 500)
          : json({ events: [startedEvent] }),
      '/run': () => json(runState()),
    });
    renderChecklist([project()]);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check your progress.');
    failing = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(meter()).toHaveAttribute('aria-valuetext', '2 of 5'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('hides for good when asked, and stays hidden for this account', async () => {
    routeFetch({});
    const { unmount } = renderChecklist([]);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByRole('heading', { name: 'Getting started' })).not.toBeInTheDocument();

    unmount();
    renderChecklist([]);
    expect(screen.queryByRole('heading', { name: 'Getting started' })).not.toBeInTheDocument();
  });

  it('is not shown to an account with three or more projects', () => {
    routeFetch({});
    renderChecklist([project({ id: 'a' }), project({ id: 'b' }), project({ id: 'c' })]);
    expect(screen.queryByRole('heading', { name: 'Getting started' })).not.toBeInTheDocument();
  });

  it('disappears once every step is done', async () => {
    routeFetch({
      '/runtime/events': () => json({ events: [startedEvent] }),
      '/run': () => json(runState({ status: 'EXITED', startedAt: '2026-01-01T00:02:00.000Z' })),
    });
    window.localStorage.setItem(`onboarding.preview.v1.${user.id}`, '2026-01-01T00:03:00.000Z');
    renderChecklist([project()], { emailVerified: true });

    // Visible until the server answers, then every item is done and the card goes.
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Getting started' })).not.toBeInTheDocument(),
    );
  });

  it('sends a verification link from the email step and then waits before another', async () => {
    const spy = routeFetch({
      'POST /api/auth/verification/send': () => json({ ok: true }),
    });
    renderChecklist([]);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Resend link' }));
    await waitFor(() =>
      expect(spy.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true),
    );
    const button = await screen.findByRole('button', { name: 'Resend link' });
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveAccessibleDescription(/You can send another in \d+s/);
  });
});
