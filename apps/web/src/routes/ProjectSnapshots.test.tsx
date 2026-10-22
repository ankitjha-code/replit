import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiProvider, clearToasts } from '../ui/index.js';
import { ProjectSnapshots } from './ProjectSnapshots.js';
import { PROJECT_ID, json, noRuntime, routeFetch, type Handlers } from './settings/test-helpers.js';

const SNAPSHOTS = `/api/projects/${PROJECT_ID}/snapshots`;

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  id: 'snap-1',
  name: 'Before the rewrite',
  description: 'Everything worked here.',
  kind: 'MANUAL',
  fileCount: 12,
  sizeBytes: 2048,
  checksum: 'abc',
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'ada',
  ...overrides,
});

const list = (snapshots: unknown[] = [snapshot()], overrides: Record<string, unknown> = {}) => ({
  snapshots,
  limit: 5,
  unavailableReason: null,
  ...overrides,
});

const quiet: Handlers = {
  [`GET /api/projects/${PROJECT_ID}/runtime`]: () => json(noRuntime),
  [`GET /api/projects/${PROJECT_ID}/files`]: () =>
    json({
      entries: [{ path: 'README.md', type: 'FILE', sizeBytes: 10, version: 3 }],
      totalBytes: 10,
    }),
};

function renderSnapshots(canWrite = true) {
  return render(
    <UiProvider>
      <ProjectSnapshots projectId={PROJECT_ID} canWrite={canWrite} />
    </UiProvider>,
  );
}

async function pickAction(name: string, action: string): Promise<void> {
  await userEvent.click(
    await screen.findByRole('button', { name: `Actions for snapshot ${name}` }),
  );
  await userEvent.click(
    await screen.findByRole('menuitem', { name: `${action} snapshot ${name}` }),
  );
}

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

describe('ProjectSnapshots', () => {
  it('lists snapshots with their kind, size and a download link, and shows the limit', async () => {
    routeFetch({
      ...quiet,
      [`GET ${SNAPSHOTS}`]: () =>
        json(
          list([
            snapshot(),
            snapshot({
              id: 'snap-2',
              name: 'Deployment 3',
              kind: 'DEPLOYMENT',
              description: null,
              sizeBytes: 4096,
            }),
          ]),
        ),
    });
    renderSnapshots();

    expect(await screen.findByText('Before the rewrite')).toBeInTheDocument();
    expect(screen.getByText('Everything worked here.')).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
    expect(screen.getByText('Deployment')).toBeInTheDocument();
    expect(screen.getByText('2.0 kB, 12 files')).toBeInTheDocument();
    expect(screen.getByText(/1 of 5 used/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Download snapshot Before the rewrite' }),
    ).toHaveAttribute('href', `${SNAPSHOTS}/snap-1/archive`);
  });

  it('shows an empty state that points at the form', async () => {
    routeFetch({ ...quiet, [`GET ${SNAPSHOTS}`]: () => json(list([])) });
    renderSnapshots();

    expect(await screen.findByText('No snapshots yet.')).toBeInTheDocument();
    expect(screen.getByText(/Take the first one above/)).toBeInTheDocument();
  });

  it('asks for a name before taking a snapshot, then sends name and note', async () => {
    let posted: unknown;
    const calls = routeFetch({
      ...quiet,
      [`POST ${SNAPSHOTS}`]: (init) => {
        posted = JSON.parse(String(init?.body));
        return json({}, 201);
      },
      [`GET ${SNAPSHOTS}`]: () => json(list([])),
    });
    renderSnapshots();

    await userEvent.click(await screen.findByRole('button', { name: 'Take a snapshot' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Give the snapshot a name');
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false);

    await userEvent.type(screen.getByLabelText('Snapshot name'), 'Before the rewrite');
    await userEvent.type(screen.getByLabelText('Note (optional)'), 'Everything worked here.');
    await userEvent.click(screen.getByRole('button', { name: 'Take a snapshot' }));

    expect(await screen.findByText('Snapshot taken')).toBeInTheDocument();
    expect(posted).toEqual({ name: 'Before the rewrite', description: 'Everything worked here.' });
    await waitFor(() => expect(screen.getByLabelText('Snapshot name')).toHaveValue(''));
  });

  it('disables taking another at the limit and says why', async () => {
    routeFetch({
      ...quiet,
      [`GET ${SNAPSHOTS}`]: () =>
        json(
          list(
            [
              snapshot(),
              snapshot({ id: 'snap-2', name: 'Two' }),
              snapshot({ id: 'snap-3', name: 'Safety', kind: 'AUTOMATIC' }),
            ],
            { limit: 2 },
          ),
        ),
    });
    renderSnapshots();

    const button = await screen.findByRole('button', { name: 'Take a snapshot' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(
      'This project has its limit of 2 snapshots. Delete one to take another.',
    );
  });

  it('restores the project behind a confirm and offers the undo through the safety snapshot', async () => {
    const calls = routeFetch({
      ...quiet,
      [`POST ${SNAPSHOTS}/snap-1/restore`]: () =>
        json({
          restore: {
            source: 'snapshot',
            reference: 'snap-1',
            label: 'Before the rewrite',
            created: 1,
            updated: 0,
            deleted: 0,
            unchanged: 11,
            safetySnapshot: snapshot({ id: 'snap-9', name: 'Before restoring', kind: 'AUTOMATIC' }),
            restartRequired: false,
          },
        }),
      [`GET ${SNAPSHOTS}`]: () => json(list()),
    });
    renderSnapshots();

    await pickAction('Before the rewrite', 'Restore project to');
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Restore project to snapshot Before the rewrite?',
    });
    expect(within(dialog).getByText(/Environment: Not available/)).toBeInTheDocument();
    expect(calls.some((c) => c.includes('/restore'))).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore project' }));

    expect(await screen.findByText('Restored Before the rewrite: 1 added.')).toBeInTheDocument();
    expect(screen.getByText(/kept as "Before restoring"/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('deletes a snapshot only after a confirm that names it', async () => {
    const calls = routeFetch({
      ...quiet,
      [`DELETE ${SNAPSHOTS}/snap-1`]: () => new Response(null, { status: 204 }),
      [`GET ${SNAPSHOTS}`]: () => json(list()),
    });
    renderSnapshots();

    await pickAction('Before the rewrite', 'Delete');
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Delete snapshot Before the rewrite?',
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete snapshot' }));

    await waitFor(() => expect(calls.some((c) => c === `DELETE ${SNAPSHOTS}/snap-1`)).toBe(true));
    expect(await screen.findByText('Deleted snapshot Before the rewrite')).toBeInTheDocument();
  });

  it('restores one file by path and says what came back', async () => {
    let posted: unknown;
    routeFetch({
      ...quiet,
      [`POST ${SNAPSHOTS}/snap-1/restore-file`]: (init) => {
        posted = JSON.parse(String(init?.body));
        return json({ path: 'README.md', previous: null });
      },
      [`GET ${SNAPSHOTS}`]: () => json(list()),
    });
    renderSnapshots();

    await pickAction('Before the rewrite', 'Restore one file from');
    const dialog = await screen.findByRole('dialog', {
      name: 'Restore one file from snapshot Before the rewrite',
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore file' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Enter the path of the file to restore',
    );

    await userEvent.type(within(dialog).getByLabelText('File'), 'README.md');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore file' }));

    expect(
      await screen.findByText('Restored README.md from snapshot Before the rewrite.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/did not exist before, so there is nothing to undo/)).toBeVisible();
    expect(posted).toEqual({ path: 'README.md' });
  });

  it('shows the error with a retry when the list cannot be read', async () => {
    let attempts = 0;
    routeFetch({
      ...quiet,
      [`GET ${SNAPSHOTS}`]: () => {
        attempts += 1;
        return attempts === 1
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'Storage is unreachable.' } }, 500)
          : json(list());
      },
    });
    renderSnapshots();

    expect(await screen.findByText('Storage is unreachable.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Before the rewrite')).toBeInTheDocument();
  });

  it('offers a viewer the list but no form and no actions', async () => {
    routeFetch({ ...quiet, [`GET ${SNAPSHOTS}`]: () => json(list()) });
    renderSnapshots(false);

    expect(await screen.findByText('Before the rewrite')).toBeInTheDocument();
    expect(screen.queryByLabelText('Snapshot name')).toBeNull();
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
  });

  it('says so when snapshots are not available on the installation', async () => {
    routeFetch({
      ...quiet,
      [`GET ${SNAPSHOTS}`]: () =>
        json(list([], { unavailableReason: 'No object store is configured.' })),
    });
    renderSnapshots();

    expect(
      await screen.findByText('Snapshots are not available on this installation.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Snapshot name')).toBeNull();
  });
});
