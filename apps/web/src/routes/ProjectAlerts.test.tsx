import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => vi.unstubAllGlobals());

describe('alerts', () => {
  it('saves what the owner chose, with a blank memory threshold meaning none', async () => {
    const { puts } = mockApi();
    render(<ProjectAlerts projectId={PROJECT} canEdit />);

    await userEvent.click(await screen.findByLabelText('Alerts on'));
    const failures = screen.getByLabelText('Failed checks in a row before alerting');
    await userEvent.clear(failures);
    await userEvent.type(failures, '5');
    await userEvent.click(screen.getByRole('button', { name: 'Save alerts' }));

    await waitFor(() =>
      expect(puts).toEqual([{ enabled: true, failuresBeforeAlert: 5, memoryPercent: null }]),
    );
  });

  it('says up front when an alert would not reach anybody', async () => {
    mockApi(response({ deliveryProblem: 'This installation cannot send email: no server' }));
    render(<ProjectAlerts projectId={PROJECT} canEdit />);
    expect(await screen.findByText(/cannot send email/)).toBeInTheDocument();
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
    render(<ProjectAlerts projectId={PROJECT} canEdit={false} />);

    expect(await screen.findByText(/Firing now: Health check/)).toBeInTheDocument();
    expect(screen.getByText(/not emailed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save alerts' })).not.toBeInTheDocument();
  });
});
