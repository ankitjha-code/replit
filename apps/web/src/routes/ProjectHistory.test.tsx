import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiProvider, clearToasts } from '../ui/index.js';
import { ProjectHistory } from './ProjectHistory.js';
import { PROJECT_ID, json, noRuntime, routeFetch, type Handlers } from './settings/test-helpers.js';

// Distinct in their first seven characters, as real object ids are.
const oid = (n: number): string => n.toString(16).repeat(40).slice(0, 40);

const commit = (n: number, message = `Change ${n}`) => ({
  oid: oid(n),
  message,
  authorName: 'ada',
  authorEmail: 'ada@example.test',
  timestamp: 1_700_000_000 + n,
  parents: n > 1 ? [oid(n - 1)] : [],
});

const state = (overrides: Record<string, unknown> = {}) => ({
  initialized: true,
  commits: [commit(2, 'Second change'), commit(1, 'First change')],
  hasUncommittedChanges: true,
  pendingChanges: [{ path: 'index.js', kind: 'modified' }],
  unavailableReason: null,
  branch: 'main',
  branches: [{ name: 'main', headOid: oid(2), current: true }],
  ...overrides,
});

const GIT = `/api/projects/${PROJECT_ID}/git`;

const quiet: Handlers = {
  [`GET /api/projects/${PROJECT_ID}/runtime`]: () => json(noRuntime),
  [`GET /api/projects/${PROJECT_ID}/files`]: () => json({ entries: [], totalBytes: 0 }),
};

function renderHistory(canWrite = true) {
  return render(
    <UiProvider>
      <ProjectHistory projectId={PROJECT_ID} canWrite={canWrite} />
    </UiProvider>,
  );
}

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

describe('ProjectHistory', () => {
  it('shows a skeleton, then the commits newest first with a page at a time', async () => {
    const commits = Array.from({ length: 25 }, (_, i) => commit(25 - i));
    routeFetch({ ...quiet, [`GET ${GIT}`]: () => json(state({ commits })) });
    renderHistory();

    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(await screen.findByText('Change 25')).toBeInTheDocument();
    expect(screen.queryByText('Change 5')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Show more (20 of 25)' }));
    expect(screen.getByText('Change 5')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull();
  });

  it('shows an empty state with the way forward when nothing was committed', async () => {
    routeFetch({
      ...quiet,
      [`GET ${GIT}`]: () =>
        json(state({ initialized: false, commits: [], hasUncommittedChanges: false })),
    });
    renderHistory();

    expect(await screen.findByText('No commits yet.')).toBeInTheDocument();
    expect(
      screen.getByText('Commit to record the current files so you can come back to them.'),
    ).toBeInTheDocument();
  });

  it('asks for a message before committing, then sends it', async () => {
    const calls = routeFetch({
      ...quiet,
      [`POST ${GIT}/commits`]: () =>
        json(state({ commits: [commit(3, 'Fix the title'), ...state().commits] })),
      [`GET ${GIT}`]: () => json(state()),
    });
    renderHistory();

    const button = await screen.findByRole('button', { name: 'Commit' });
    expect(screen.getByText('1 file would go into this commit.')).toBeInTheDocument();
    await userEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('Say what changed');
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false);

    await userEvent.type(screen.getByLabelText('Commit message'), 'Fix the title');
    await userEvent.click(screen.getByRole('button', { name: 'Commit' }));

    expect(await screen.findByText('Committed')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Commit message')).toHaveValue(''));
    expect(calls.some((c) => c === `POST ${GIT}/commits`)).toBe(true);
  });

  it('disables Commit with the reason beside it when nothing has changed', async () => {
    routeFetch({
      ...quiet,
      [`GET ${GIT}`]: () => json(state({ hasUncommittedChanges: false, pendingChanges: [] })),
    });
    renderHistory();

    const button = await screen.findByRole('button', { name: 'Commit' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Nothing has changed since the last commit.');
  });

  it("shows a failed read of a commit's changes as an error with a retry, never as no changes", async () => {
    let detailAnswers = 0;
    routeFetch({
      ...quiet,
      [`GET ${GIT}/commits/${oid(2)}`]: () => {
        detailAnswers += 1;
        return detailAnswers === 1
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'Storage timed out.' } }, 500)
          : json({ commit: commit(2), changes: [{ path: 'src/index.js', kind: 'modified' }] });
      },
      [`GET ${GIT}`]: () => json(state()),
    });
    renderHistory();

    await userEvent.click(
      await screen.findByRole('button', { name: `Show changes in commit ${oid(2).slice(0, 7)}` }),
    );
    expect(await screen.findByText("Could not load this commit's changes.")).toBeInTheDocument();
    expect(screen.getByText('Storage timed out.')).toBeInTheDocument();
    expect(screen.queryByText('No file changes.')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('src/index.js')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Restore this file: src\/index.js/ })).toBeEnabled();
  });

  it('restores one file from a commit and offers the undo', async () => {
    const bodies: unknown[] = [];
    routeFetch({
      ...quiet,
      [`GET ${GIT}/commits/${oid(1)}`]: () =>
        json({
          commit: commit(1),
          changes: [
            { path: 'README.md', kind: 'modified' },
            { path: 'old.txt', kind: 'removed' },
          ],
        }),
      [`POST ${GIT}/commits/${oid(1)}/restore-file`]: (init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return json({ path: 'README.md', previous: { content: 'before', encoding: 'utf8' } });
      },
      [`GET ${GIT}`]: () => json(state()),
    });
    renderHistory();

    await userEvent.click(
      await screen.findByRole('button', { name: `Show changes in commit ${oid(1).slice(0, 7)}` }),
    );
    expect(
      await screen.findByRole('button', { name: /Restore this file: old.txt/ }),
    ).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /Restore this file: README.md/ }));

    expect(
      await screen.findByText(`Restored README.md from commit ${oid(1).slice(0, 7)}.`),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(bodies).toEqual([{ path: 'README.md' }]);
  });

  it('restores the project behind a confirm and reports what was kept', async () => {
    const calls = routeFetch({
      ...quiet,
      [`POST ${GIT}/commits/${oid(1)}/restore`]: () =>
        json({
          restore: {
            source: 'commit',
            reference: oid(1),
            label: 'First change',
            created: 0,
            updated: 2,
            deleted: 1,
            unchanged: 3,
            safetySnapshot: {
              id: 'snap-1',
              name: 'Before restoring First change',
              description: null,
              kind: 'AUTOMATIC',
              fileCount: 6,
              sizeBytes: 1024,
              checksum: 'x',
              createdAt: '2026-01-01T00:00:00.000Z',
              createdBy: 'ada',
            },
            restartRequired: false,
          },
        }),
      [`GET ${GIT}`]: () => json(state()),
    });
    renderHistory();

    const short = oid(1).slice(0, 7);
    await userEvent.click(
      await screen.findByRole('button', { name: `Restore project to commit ${short}` }),
    );
    const dialog = await screen.findByRole('alertdialog', {
      name: `Restore project to commit ${short}?`,
    });
    expect(within(dialog).getByText(/Environment: Not available/)).toBeInTheDocument();
    expect(calls.some((c) => c.includes('/restore'))).toBe(false);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore project' }));
    expect(
      await screen.findByText('Restored First change: 2 changed, 1 removed.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/"Before restoring First change"/)).toBeInTheDocument();
  });

  it('keeps the confirm open with the refusal when the environment is still running', async () => {
    routeFetch({
      ...quiet,
      [`POST ${GIT}/commits/${oid(1)}/restore`]: () =>
        json(
          { error: { code: 'CONFLICT', message: 'Stop the environment before restoring.' } },
          409,
        ),
      [`GET ${GIT}`]: () => json(state()),
    });
    renderHistory();

    await userEvent.click(
      await screen.findByRole('button', {
        name: `Restore project to commit ${oid(1).slice(0, 7)}`,
      }),
    );
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore project' }));

    expect(
      await within(dialog).findByText('Stop the environment before restoring.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Retry: Restore project' })).toBeEnabled();
  });

  it('offers a viewer the history but no way to change it', async () => {
    routeFetch({ ...quiet, [`GET ${GIT}`]: () => json(state()) });
    renderHistory(false);

    expect(await screen.findByText('Second change')).toBeInTheDocument();
    expect(screen.queryByLabelText('Commit message')).toBeNull();
    expect(screen.queryByRole('button', { name: /Restore project to/ })).toBeNull();
  });

  it('says so when history is not available on the installation', async () => {
    routeFetch({
      ...quiet,
      [`GET ${GIT}`]: () =>
        json(
          state({
            initialized: false,
            commits: [],
            pendingChanges: [],
            unavailableReason: 'No object store is configured.',
          }),
        ),
    });
    renderHistory();

    expect(
      await screen.findByText('History is not available on this installation.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Commit message')).toBeNull();
  });
});
