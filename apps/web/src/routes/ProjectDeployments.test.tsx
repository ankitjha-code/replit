import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiProvider, clearToasts } from '../ui/index.js';
import { ProjectDeployments } from './ProjectDeployments.js';
import { PROJECT_ID, SHIP_API, deployment, deploymentState, job } from './ship/fixtures.js';
import { json, routeFetch, type Handlers } from './settings/test-helpers.js';

function renderDeployments(onAddressChanged = vi.fn(), addressNonce = 0) {
  const view = render(
    <MemoryRouter>
      <UiProvider>
        <ProjectDeployments
          projectId={PROJECT_ID}
          addressNonce={addressNonce}
          onAddressChanged={onAddressChanged}
        />
      </UiProvider>
    </MemoryRouter>,
  );
  const rerender = (nonce: number) =>
    view.rerender(
      <MemoryRouter>
        <UiProvider>
          <ProjectDeployments
            projectId={PROJECT_ID}
            addressNonce={nonce}
            onAddressChanged={onAddressChanged}
          />
        </UiProvider>
      </MemoryRouter>,
    );
  return { ...view, rerender, onAddressChanged };
}

const STATIC_CONFIG = {
  target: 'STATIC' as const,
  buildCommand: 'npm run build',
  outputDirectory: 'dist',
  startCommand: null,
};

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

describe('ProjectDeployments', () => {
  it('keeps Deploy on screen with the configuration problem as its reason', async () => {
    const calls = routeFetch({
      [`GET ${SHIP_API}/deployments`]: () => json(deploymentState()),
    });
    renderDeployments();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Deploy' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Deploy' })).toHaveAccessibleDescription(
      'A static site needs to know which directory holds the built files.',
    );
    expect(screen.getByText('Nothing has been deployed yet.')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Directory to serve'), 'dist');
    expect(screen.getByRole('button', { name: 'Deploy' })).toBeEnabled();
    expect(calls.filter((call) => !call.startsWith('GET'))).toEqual([]);
  });

  it('says when deployments are not available here, and Deploy carries the reason', async () => {
    routeFetch({
      [`GET ${SHIP_API}/deployments`]: () =>
        json(
          deploymentState({
            config: STATIC_CONFIG,
            unavailableReason: 'No deployment backend is configured.',
          }),
        ),
    });
    renderDeployments();

    expect(
      await screen.findByText('Deployments are not available on this installation.'),
    ).toBeInTheDocument();
    const deploy = screen.getByRole('button', { name: 'Deploy' });
    expect(deploy).toBeDisabled();
    expect(deploy).toHaveAccessibleDescription('No deployment backend is configured.');
  });

  it('deploying saves a changed configuration first, then asks for the deployment', async () => {
    const bodies: { method: string; url: string; body: unknown }[] = [];
    const handlers: Handlers = {
      [`GET ${SHIP_API}/deployments`]: () =>
        json(deploymentState({ suggestion: { ...STATIC_CONFIG, outputDirectory: 'public' } })),
      [`PUT ${SHIP_API}/deployments/config`]: (init) => {
        bodies.push({ method: 'PUT', url: 'config', body: JSON.parse(String(init?.body)) });
        return json(deploymentState({ config: STATIC_CONFIG }));
      },
      [`POST ${SHIP_API}/deployments`]: (init) => {
        bodies.push({ method: 'POST', url: 'deployments', body: JSON.parse(String(init?.body)) });
        return json({ deployment: deployment('new', { status: 'REQUESTED' }) }, 201);
      },
    };
    routeFetch(handlers);
    const { onAddressChanged } = renderDeployments();

    const output = await screen.findByLabelText('Directory to serve');
    await waitFor(() => expect(output).toHaveValue('public'));
    expect(screen.getByText('Suggested from the files in this project.')).toBeInTheDocument();

    await userEvent.clear(output);
    await userEvent.type(output, 'dist');
    await userEvent.type(screen.getByLabelText('Note (optional)'), 'first one');
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    await waitFor(() => expect(onAddressChanged).toHaveBeenCalled());
    expect(bodies.map((entry) => entry.method)).toEqual(['PUT', 'POST']);
    expect(bodies[0]?.body).toEqual(STATIC_CONFIG);
    expect(bodies[1]?.body).toEqual({ note: 'first one' });
    expect(await screen.findByText('Deployment queued')).toBeInTheDocument();
  });

  it('a reload of the list does not overwrite what is being typed', async () => {
    routeFetch({
      [`GET ${SHIP_API}/deployments`]: () => json(deploymentState({ config: STATIC_CONFIG })),
    });
    const { rerender } = renderDeployments();

    const build = await screen.findByLabelText('Build command');
    await waitFor(() => expect(build).toHaveValue('npm run build'));
    await userEvent.clear(build);
    await userEvent.type(build, 'make site');

    rerender(1);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save without deploying' })).toBeEnabled(),
    );
    expect(screen.getByLabelText('Build command')).toHaveValue('make site');
  });

  it('shows the Live URL with a copy and the live row with its stop confirm', async () => {
    const live = deployment('live01', {
      status: 'RUNNING',
      url: 'http://hello.deploy.localhost:4100',
      releaseUrl: 'http://live01.hello.deploy.localhost:4100',
      startedAt: '2026-01-01T10:02:00.000Z',
    });
    const calls = routeFetch({
      [`GET ${SHIP_API}/deployments`]: () =>
        json(
          deploymentState({
            deployments: [live],
            liveId: live.id,
            subdomain: 'hello',
            url: 'http://hello.deploy.localhost:4100',
            config: STATIC_CONFIG,
          }),
        ),
      [`POST ${SHIP_API}/deployments/live01/stop`]: () =>
        json({ deployment: { ...live, status: 'STOPPING' } }),
    });
    renderDeployments();

    expect(await screen.findByRole('button', { name: 'Copy Live URL' })).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'http://hello.deploy.localhost:4100' }),
    ).toHaveAttribute('target', '_blank');
    expect(screen.getAllByText('Live')).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: 'Stop deployment live01' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Stop the live site?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop deployment live01' }));

    await waitFor(() => expect(calls).toContain(`POST ${SHIP_API}/deployments/live01/stop`));
    expect(await screen.findByText('Deployment stopped')).toBeInTheDocument();
  });

  it('shows a failed build log as a failure with a retry, never as an empty log', async () => {
    let logAttempts = 0;
    routeFetch({
      [`GET ${SHIP_API}/deployments/old001/log`]: () => {
        logAttempts += 1;
        return logAttempts === 1
          ? json({ error: { code: 'INTERNAL', message: 'Storage is unreachable.' } }, 500)
          : json({ log: 'npm ERR! missing script: build\n', truncated: true });
      },
      [`GET ${SHIP_API}/deployments`]: () =>
        json(
          deploymentState({
            deployments: [deployment('old001', { status: 'FAILED', message: 'Build failed.' })],
            config: STATIC_CONFIG,
          }),
        ),
    });
    renderDeployments();

    await screen.findByText('Build failed.');
    await userEvent.click(screen.getByRole('button', { name: 'Actions for deployment old001' }));
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Build output for deployment old001' }),
    );

    const dialog = await screen.findByRole('dialog', {
      name: 'Build output for deployment old001',
    });
    expect(await within(dialog).findByText(/Could not load this log/)).toBeInTheDocument();
    expect(screen.queryByText('This build printed nothing.')).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(await within(dialog).findByLabelText('Build log')).toHaveTextContent(
      'npm ERR! missing script: build',
    );
    expect(within(dialog).getByText(/Only the end of this build/)).toBeInTheDocument();
  });

  it('rolling back asks first, warns about a rebuild for a server, and sends the note', async () => {
    let rollbackBody: unknown;
    routeFetch({
      [`GET ${SHIP_API}/deployments`]: () =>
        json(
          deploymentState({
            deployments: [
              deployment('srv001', {
                target: 'SERVER',
                outputDirectory: null,
                startCommand: 'npm start',
                fileCount: null,
                artifactBytes: null,
              }),
            ],
            config: {
              ...STATIC_CONFIG,
              target: 'SERVER',
              outputDirectory: null,
              startCommand: 'npm start',
            },
          }),
        ),
      [`POST ${SHIP_API}/deployments/srv001/rollback`]: (init) => {
        rollbackBody = JSON.parse(String(init?.body));
        return json(
          { deployment: deployment('new', { status: 'REQUESTED', target: 'SERVER' }) },
          202,
        );
      },
    });
    renderDeployments();

    await screen.findByRole('button', { name: 'Actions for deployment srv001' });
    await userEvent.click(screen.getByRole('button', { name: 'Actions for deployment srv001' }));
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Roll back to deployment srv001' }),
    );

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Roll back to deployment srv001?',
    });
    expect(within(dialog).getByText(/built again from the same code/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Note (optional)'), 'back to v1');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Roll back to deployment srv001' }),
    );

    await waitFor(() => expect(rollbackBody).toEqual({ note: 'back to v1' }));
  });

  it('a queued build shows its progress and can be cancelled through its job', async () => {
    const queued = deployment('q00001', {
      status: 'REQUESTED',
      hasLog: false,
      fileCount: null,
      artifactBytes: null,
      createdAt: new Date(Date.now() - 20_000).toISOString(),
      statusChangedAt: new Date(Date.now() - 20_000).toISOString(),
    });
    const calls = routeFetch({
      [`GET ${SHIP_API}/deployments/q00001/log`]: () => json({ log: '', truncated: false }),
      [`GET ${SHIP_API}/deployments`]: () =>
        json(deploymentState({ deployments: [queued], config: STATIC_CONFIG })),
      [`GET ${SHIP_API}/jobs`]: () =>
        json({
          jobs: [
            job('done', { type: 'DEPLOYMENT_BUILD', status: 'SUCCEEDED', deploymentId: 'q00001' }),
            job('other', {
              type: 'DEPLOYMENT_BUILD',
              createdAt: queued.createdAt,
              deploymentId: 'q00002',
            }),
            job('build', {
              type: 'DEPLOYMENT_BUILD',
              createdAt: queued.createdAt,
              deploymentId: 'q00001',
            }),
          ],
          workerRunning: true,
        }),
      [`POST ${SHIP_API}/jobs/build/cancel`]: () =>
        json({ job: job('build', { type: 'DEPLOYMENT_BUILD', status: 'CANCELLED' }) }),
    });
    renderDeployments();

    expect(await screen.findByText(/Queued for \d+s/)).toBeInTheDocument();
    expect(screen.getByText(/You can leave this page/)).toBeInTheDocument();
    expect(screen.getByText('Waiting for a worker to pick this up.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel build' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Cancel this build?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel build' }));

    await waitFor(() => expect(calls).toContain(`POST ${SHIP_API}/jobs/build/cancel`));
    expect(calls).not.toContain(`POST ${SHIP_API}/jobs/other/cancel`);
  });

  it('a build a worker holds shows the elapsed step and why it cannot be cancelled', async () => {
    routeFetch({
      [`GET ${SHIP_API}/deployments/b00001/log`]: () =>
        json({ log: 'line 1\nline 2\n', truncated: false }),
      [`GET ${SHIP_API}/deployments`]: () =>
        json(
          deploymentState({
            deployments: [
              deployment('b00001', {
                status: 'BUILDING',
                hasLog: false,
                statusChangedAt: new Date(Date.now() - 80_000).toISOString(),
              }),
            ],
            config: STATIC_CONFIG,
          }),
        ),
    });
    renderDeployments();

    expect(await screen.findByText(/Building for 1m 2\ds/)).toBeInTheDocument();
    const cancel = screen.getByRole('button', { name: 'Cancel build' });
    expect(cancel).toBeDisabled();
    expect(cancel).toHaveAccessibleDescription(/already started on a worker/);
    expect(await screen.findByLabelText('Build output so far')).toHaveTextContent('line 2');
  });

  it('shows the list failure with a retry', async () => {
    let attempts = 0;
    routeFetch({
      [`GET ${SHIP_API}/deployments`]: () => {
        attempts += 1;
        return attempts === 1
          ? json({ error: { code: 'INTERNAL', message: 'Database is down.' } }, 500)
          : json(deploymentState({ config: STATIC_CONFIG }));
      },
    });
    renderDeployments();

    expect(await screen.findByRole('alert')).toHaveTextContent('Database is down.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Nothing has been deployed yet.')).toBeInTheDocument();
  });
});
