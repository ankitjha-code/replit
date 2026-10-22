import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiProvider, clearToasts } from '../ui/index.js';
import { ProjectJobs } from './ProjectJobs.js';
import { PROJECT_ID, SHIP_API, deployment, deploymentState, job } from './ship/fixtures.js';
import { json, routeFetch } from './settings/test-helpers.js';

/**
 * Activity: rows in the words of the person who pressed the button, a build
 * linked to its deployment, a cancel that asks and says it is cancelling,
 * and a warning whenever nothing is doing the work.
 */

function renderJobs(canControl = true) {
  render(
    <MemoryRouter>
      <UiProvider>
        <ProjectJobs projectId={PROJECT_ID} canControl={canControl} />
      </UiProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

describe('ProjectJobs', () => {
  it('names the work in user verbs and links a build to its deployment', async () => {
    routeFetch({
      [`GET ${SHIP_API}/jobs`]: () =>
        json({
          jobs: [
            job('build', {
              type: 'DEPLOYMENT_BUILD',
              status: 'RUNNING',
              deploymentId: 'd00001',
              startedAt: '2026-01-01T10:00:05.000Z',
              createdAt: '2026-01-01T10:00:01.000Z',
            }),
            job('start', {
              status: 'FAILED',
              attempts: 3,
              lastError: 'The image could not be pulled.',
              finishedAt: '2026-01-01T09:00:00.000Z',
            }),
          ],
          workerRunning: true,
        }),
      [`GET ${SHIP_API}/deployments`]: () =>
        json(
          deploymentState({
            deployments: [deployment('d00001', { status: 'BUILDING', note: 'v2' })],
          }),
        ),
    });
    renderJobs();

    const link = await screen.findByRole('link', { name: 'deployment d00001' });
    expect(link.closest('tr')).toHaveTextContent(/Building deployment deployment d00001 \(v2\)/);
    expect(link).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/settings/deploy#deploy-deployments`,
    );
    expect(screen.getByText('In progress')).toBeInTheDocument();

    expect(screen.getByText('Starting environment')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Attempt 3 of 3')).toBeInTheDocument();
    expect(screen.getByText('The image could not be pulled.')).toBeInTheDocument();
    expect(screen.queryByText(/No worker is running/)).not.toBeInTheDocument();
  });

  it('links a build to the deployment it names, not to one created at the same time', async () => {
    routeFetch({
      [`GET ${SHIP_API}/jobs`]: () =>
        json({
          jobs: [
            job('build', {
              type: 'DEPLOYMENT_BUILD',
              deploymentId: 'd00002',
              createdAt: '2026-01-01T10:00:00.000Z',
            }),
          ],
          workerRunning: true,
        }),
      // d00002 is not in the list (pruned, or the list failed): the job still
      // names it, and the deployment created in the same second is not used.
      [`GET ${SHIP_API}/deployments`]: () =>
        json(
          deploymentState({
            deployments: [
              deployment('d00001', { note: 'v1', createdAt: '2026-01-01T10:00:00.000Z' }),
            ],
          }),
        ),
    });
    renderJobs();

    const link = await screen.findByRole('link', { name: 'deployment d00002' });
    // No note in brackets: that would have come from the wrong deployment.
    expect(link.parentElement).toHaveTextContent(/^Building deployment deployment d00002$/);
    expect(screen.queryByRole('link', { name: 'deployment d00001' })).not.toBeInTheDocument();
  });

  it('warns whenever no worker is running, even with nothing queued', async () => {
    routeFetch({
      [`GET ${SHIP_API}/jobs`]: () => json({ jobs: [], workerRunning: false }),
      [`GET ${SHIP_API}/deployments`]: () => json(deploymentState()),
    });
    renderJobs();

    expect(await screen.findByText('No worker is running on this platform.')).toBeInTheDocument();
    expect(screen.getByText('Nothing in progress.')).toBeInTheDocument();
  });

  it('cancels queued work after asking, and says it is cancelling meanwhile', async () => {
    let release: (() => void) | undefined;
    const calls = routeFetch({
      [`GET ${SHIP_API}/jobs`]: () =>
        json({
          jobs: [job('q1'), job('running', { status: 'RUNNING' })],
          workerRunning: true,
        }),
      [`GET ${SHIP_API}/deployments`]: () => json(deploymentState()),
    });
    // The cancel answers only when the test lets it, so the in-flight state is visible.
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const scripted = fetchSpy.getMockImplementation() as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    fetchSpy.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST' && String(input).includes('/jobs/q1/cancel')) {
        calls.push(`POST ${SHIP_API}/jobs/q1/cancel`);
        return new Promise<Response>((resolve) => {
          release = () => resolve(json({ job: job('q1', { status: 'CANCELLED' }) }));
        });
      }
      return scripted(input, init);
    });
    renderJobs();

    expect(await screen.findByText('Queued')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Cancel starting environment' }),
    ).toBeInTheDocument();
    // A running job cannot be cancelled, so no action is offered for it.
    expect(screen.getAllByRole('button', { name: /^Cancel / })).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel starting environment' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Cancel starting environment?',
    });
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Cancel starting environment' }),
    );

    expect(await screen.findByText('Cancelling')).toBeInTheDocument();
    expect(calls).toContain(`POST ${SHIP_API}/jobs/q1/cancel`);
    release?.();
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
  });

  it('offers no cancel to someone who cannot control the environment', async () => {
    routeFetch({
      [`GET ${SHIP_API}/jobs`]: () => json({ jobs: [job('q1')], workerRunning: true }),
      [`GET ${SHIP_API}/deployments`]: () => json(deploymentState()),
    });
    renderJobs(false);

    expect(await screen.findByText('Queued')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Cancel / })).not.toBeInTheDocument();
  });

  it('shows ten rows and the rest on request', async () => {
    routeFetch({
      [`GET ${SHIP_API}/jobs`]: () =>
        json({
          jobs: Array.from({ length: 12 }, (_, index) =>
            job(`j${index}`, { status: 'SUCCEEDED', finishedAt: '2026-01-01T10:00:00.000Z' }),
          ),
          workerRunning: true,
        }),
      [`GET ${SHIP_API}/deployments`]: () => json(deploymentState()),
    });
    renderJobs();

    expect(await screen.findByText('10 of 12')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getByText('12 of 12')).toBeInTheDocument());
  });
});
