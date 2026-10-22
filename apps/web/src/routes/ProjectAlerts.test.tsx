import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiProvider, clearToasts } from '../ui/index.js';
import { ProjectAlerts } from './ProjectAlerts.js';

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const response = (overrides: Record<string, unknown> = {}) => ({
  settings: { enabled: false, failuresBeforeAlert: 3, memoryPercent: null },
  firing: [],
  lastCheckedAt: null,
  events: [],
  deliveryProblem: null,
  ...overrides,
});

function mockApi(initial = response()) {
  const puts: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        puts.push(body);
        return Promise.resolve(json(response({ settings: body })));
      }
      return Promise.resolve(json(initial));
    }),
  );
  return { puts };
}

/** The email callout links to the account page, so the section needs a router. */
const renderAlerts = (canEdit: boolean) =>
  render(
    <MemoryRouter>
      <UiProvider>
        <ProjectAlerts projectId={PROJECT} canEdit={canEdit} />
      </UiProvider>
    </MemoryRouter>,
  );

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

describe('alerts', () => {
  it('saves what the owner chose, with a blank memory threshold meaning none', async () => {
    const { puts } = mockApi();
    renderAlerts(true);

    await userEvent.click(await screen.findByLabelText('Alerts on'));
    const failures = screen.getByLabelText('Failed checks in a row before alerting');
    await userEvent.clear(failures);
    await userEvent.type(failures, '5');
    await userEvent.click(screen.getByRole('button', { name: 'Save alerts' }));

    await waitFor(() =>
      expect(puts).toEqual([{ enabled: true, failuresBeforeAlert: 5, memoryPercent: null }]),
    );
    expect(await screen.findByText('Alerts saved')).toBeInTheDocument();
  });

  it('keeps Save disabled, with the reason, until something changes', async () => {
    mockApi();
    renderAlerts(true);

    const save = await screen.findByRole('button', { name: 'Save alerts' });
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription('Nothing has changed yet');
  });

  it('says up front when an alert would not reach anybody', async () => {
    mockApi(response({ deliveryProblem: 'This installation cannot send email: no server' }));
    renderAlerts(true);
    expect(await screen.findByText(/cannot send email/)).toBeInTheDocument();
  });

  it('points an owner with an unconfirmed address at the account page, calmly', async () => {
    mockApi(
      response({
        deliveryProblem:
          'The owner of this project has not confirmed their email address, so alerts are recorded here but not sent.',
      }),
    );
    renderAlerts(true);

    const message = await screen.findByText(/has not confirmed their email address/);
    // A status, not an alert: nothing is broken, and the fix is one click away.
    expect(message.closest('[role="status"]')).toBeInTheDocument();
    expect(message.closest('[role="alert"]')).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Confirm your email on the account page' }),
    ).toHaveAttribute('href', '/account');
  });

  it('shows what fired and whether anyone was told, and no form to a viewer', async () => {
    mockApi(
      response({
        settings: { enabled: true, failuresBeforeAlert: 3, memoryPercent: null },
        firing: ['HEALTH'],
        events: [
          {
            id: 'e1',
            kind: 'HEALTH',
            state: 'FIRING',
            message: 'The deployment failed its health check 3 times in a row.',
            notified: false,
            at: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    renderAlerts(false);

    expect(await screen.findByText(/Firing now: Health check/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See the readings' })).toHaveAttribute(
      'href',
      '#monitoring-resources',
    );
    expect(screen.getByText(/not emailed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save alerts' })).not.toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Recent alerts' })).toBeInTheDocument();
  });

  it('shows the error with a retry when the alerts cannot be read', async () => {
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        attempts += 1;
        return Promise.resolve(
          attempts === 1
            ? json(
                { error: { code: 'INTERNAL', message: 'Alerts are unavailable right now.' } },
                500,
              )
            : json(response()),
        );
      }),
    );
    renderAlerts(true);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Alerts are unavailable right now.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Alerts on')).toBeInTheDocument();
  });
});
