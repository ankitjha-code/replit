import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiProvider, clearToasts } from '../ui/index.js';
import { ProjectBranches } from './ProjectBranches.js';

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';
const OID = 'a'.repeat(40);
const FEATURE_OID = 'b'.repeat(40);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const failure = (code: string, message: string, status: number) =>
  json({ error: { code, message } }, status);

const state = (overrides: Record<string, unknown> = {}) => ({
  initialized: true,
  commits: [],
  hasUncommittedChanges: false,
  pendingChanges: [],
  unavailableReason: null,
  branch: 'main',
  branches: [
    { name: 'feature/x', headOid: FEATURE_OID, current: false },
    { name: 'main', headOid: OID, current: true },
  ],
  ...overrides,
});

const storedRemote = {
  url: 'https://example.test/r.git',
  username: null,
  hasToken: true,
  lastPushedAt: null,
  lastPulledAt: null,
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function mockApi(
  options: {
    git?: Record<string, unknown>;
    remote?: unknown;
    push?: Response[];
  } = {},
) {
  const calls: Call[] = [];
  let remote = options.remote ?? null;
  const pushAnswers = [...(options.push ?? [])];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });

      if (url.endsWith('/git/remote')) {
        if (method === 'PUT') {
          remote = storedRemote;
          return Promise.resolve(json({ remote }));
        }
        if (method === 'DELETE') {
          remote = null;
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.resolve(json({ remote }));
      }
      if (url.endsWith('/merge')) {
        return Promise.resolve(
          json({ merge: { outcome: 'fastForward', headOid: OID }, state: state() }),
        );
      }
      if (url.endsWith('/push')) {
        const answer = pushAnswers.length > 1 ? pushAnswers.shift() : pushAnswers[0];
        return Promise.resolve(answer ?? json(state(options.git)));
      }
      return Promise.resolve(json(state(options.git)));
    }),
  );
  return { calls };
}

function renderBranches(props: Partial<Parameters<typeof ProjectBranches>[0]> = {}) {
  return render(
    <UiProvider>
      <ProjectBranches projectId={PROJECT} canWrite canManageRemote {...props} />
    </UiProvider>,
  );
}

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

describe('branches', () => {
  it('switches with the branch name encoded, and tells the history to reload', async () => {
    const { calls } = mockApi();
    const onChanged = vi.fn();
    renderBranches({ onChanged });

    await userEvent.click(await screen.findByRole('button', { name: 'Switch to' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls.some((c) => c.url.endsWith('/branches/feature%2Fx/switch'))).toBe(true);
  });

  it('will not offer to switch or merge over uncommitted work, and says why', async () => {
    mockApi({ git: { hasUncommittedChanges: true } });
    renderBranches();

    const switchTo = await screen.findByRole('button', { name: 'Switch to' });
    expect(switchTo).toBeDisabled();
    expect(switchTo).toHaveAccessibleDescription(/Commit your changes first/);
    expect(screen.getByRole('button', { name: 'Merge into main' })).toBeDisabled();
    expect(screen.getByText(/with uncommitted changes/)).toBeInTheDocument();
  });

  it('asks before merging, then says how the merge went', async () => {
    const { calls } = mockApi();
    renderBranches();
    await userEvent.click(await screen.findByRole('button', { name: 'Merge into main' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Merge feature/x into main?' });
    expect(calls.some((c) => c.url.endsWith('/merge'))).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));

    expect(await screen.findByText(/no merge commit was needed/)).toBeInTheDocument();
    expect(calls.find((c) => c.url.endsWith('/merge'))?.body).toEqual({ branch: 'feature/x' });
  });

  it('deletes a branch only after a confirm that names it', async () => {
    const { calls } = mockApi();
    renderBranches();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete branch feature/x' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Delete branch feature/x?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete branch' }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/branches/feature%2Fx')),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('creates a branch from another branch by sending its commit as "from"', async () => {
    const { calls } = mockApi();
    renderBranches();
    await userEvent.click(await screen.findByRole('button', { name: 'New branch' }));

    const dialog = await screen.findByRole('dialog', { name: 'New branch' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create branch' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Name the branch');
    expect(calls.some((c) => c.url.endsWith('/branches') && c.method === 'POST')).toBe(false);

    await userEvent.type(within(dialog).getByLabelText('Branch name'), 'topic');
    await userEvent.selectOptions(within(dialog).getByLabelText('From'), 'feature/x');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create branch' }));

    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/branches') && c.method === 'POST')?.body).toEqual({
        name: 'topic',
        from: FEATURE_OID,
      }),
    );
  });

  it('says so when git is not available on the installation', async () => {
    mockApi({
      git: { initialized: false, unavailableReason: 'No object store is configured.' },
    });
    renderBranches();

    expect(
      await screen.findByText('Git is not available on this installation.'),
    ).toBeInTheDocument();
    expect(screen.getByText('No object store is configured.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New branch' })).toBeNull();
  });
});

describe('the remote', () => {
  it('sends a token only when one is typed, and never shows it back', async () => {
    const { calls } = mockApi();
    renderBranches();

    await userEvent.type(await screen.findByLabelText('Remote URL'), 'https://example.test/r.git');
    await userEvent.type(screen.getByLabelText('Access token (optional)'), 'ghp_secret');
    await userEvent.click(screen.getByRole('button', { name: 'Save remote' }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        url: 'https://example.test/r.git',
        token: 'ghp_secret',
      }),
    );
    expect(await screen.findByText(/with a stored token/)).toBeInTheDocument();
    expect(screen.getByLabelText('Replace token (blank keeps it)')).toHaveValue('');
  });

  it('leaves the page one primary action, the branch one, before a remote is set', async () => {
    mockApi({ git: { branches: [{ name: 'main', headOid: OID, current: true }] } });
    const { container } = renderBranches();

    expect(await screen.findByRole('button', { name: 'Save remote' })).not.toHaveClass(
      'ui-button--primary',
    );
    const primaries = container.querySelectorAll('.ui-button--primary');
    expect([...primaries].map((button) => button.textContent)).toEqual(['New branch']);
  });

  it('offers no remote settings to someone who is not the owner', async () => {
    mockApi({ remote: storedRemote });
    renderBranches({ canManageRemote: false });

    expect(await screen.findByRole('button', { name: 'Push main' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Remote URL')).not.toBeInTheDocument();
  });

  it('shows a skeleton while loading rather than saying there is no remote', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    renderBranches({ canManageRemote: false });

    expect(screen.queryByText('No remote yet.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Push main' })).toBeNull();
    expect(document.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThan(0);
  });

  it('offers a force push after the remote rejects a push, behind a confirm', async () => {
    const { calls } = mockApi({
      remote: storedRemote,
      push: [
        failure('CONFLICT', 'The remote has commits this branch does not.', 409),
        json(state()),
      ],
    });
    renderBranches();

    await userEvent.click(await screen.findByRole('button', { name: 'Push main' }));
    expect(await screen.findByText('Could not push.')).toBeInTheDocument();
    expect(screen.getByText('The remote has commits this branch does not.')).toBeInTheDocument();

    const force = await screen.findByRole('checkbox', { name: 'Force push' });
    await userEvent.click(force);
    await userEvent.click(screen.getByRole('button', { name: 'Push main' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Force push main?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Force push' }));

    expect(await screen.findByText('Force pushed main.')).toBeInTheDocument();
    const pushes = calls.filter((c) => c.url.endsWith('/push'));
    expect(pushes.map((c) => c.body)).toEqual([{}, { force: true }]);
  });

  it('removes the remote only after a confirm', async () => {
    const { calls } = mockApi({ remote: storedRemote });
    renderBranches();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove remote' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove the remote?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove remote' }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/git/remote'))).toBe(true),
    );
    expect(await screen.findByLabelText('Remote URL')).toHaveValue('');
  });
});
