import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectBranches } from './ProjectBranches.js';

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';
const OID = 'a'.repeat(40);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const state = (overrides: Record<string, unknown> = {}) => ({
  initialized: true,
  commits: [],
  hasUncommittedChanges: false,
  pendingChanges: [],
  unavailableReason: null,
  branch: 'main',
  branches: [
    { name: 'feature/x', headOid: OID, current: false },
    { name: 'main', headOid: OID, current: true },
  ],
  ...overrides,
});

function mockApi(options: { git?: Record<string, unknown>; remote?: unknown } = {}) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  let remote = options.remote ?? null;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });

      if (url.endsWith('/git/remote')) {
        if (method === 'PUT') {
          remote = {
            url: 'https://example.test/r.git',
            username: null,
            hasToken: true,
            lastPushedAt: null,
            lastPulledAt: null,
          };
          return Promise.resolve(json({ remote }));
        }
        return Promise.resolve(json({ remote }));
      }
      if (url.endsWith('/merge')) {
        return Promise.resolve(
          json({ merge: { outcome: 'fastForward', headOid: OID }, state: state() }),
        );
      }
      return Promise.resolve(json(state(options.git)));
    }),
  );
  return { calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('branches', () => {
  it('switches with the branch name encoded, and tells the history to reload', async () => {
    const { calls } = mockApi();
    const onChanged = vi.fn();
    render(<ProjectBranches projectId={PROJECT} canWrite canManageRemote onChanged={onChanged} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Switch to' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls.some((c) => c.url.endsWith('/branches/feature%2Fx/switch'))).toBe(true);
  });

  it('will not offer to switch or merge over uncommitted work', async () => {
    mockApi({ git: { hasUncommittedChanges: true } });
    render(<ProjectBranches projectId={PROJECT} canWrite canManageRemote onChanged={() => {}} />);

    expect(await screen.findByRole('button', { name: 'Switch to' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Merge into main' })).toBeDisabled();
    expect(screen.getByText(/with uncommitted changes/)).toBeInTheDocument();
  });

  it('says how a merge went', async () => {
    mockApi();
    render(<ProjectBranches projectId={PROJECT} canWrite canManageRemote onChanged={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Merge into main' }));
    expect(await screen.findByText(/no merge commit was needed/)).toBeInTheDocument();
  });
});

describe('the remote', () => {
  it('sends a token only when one is typed, and never shows it back', async () => {
    const { calls } = mockApi();
    render(<ProjectBranches projectId={PROJECT} canWrite canManageRemote onChanged={() => {}} />);

    await userEvent.type(await screen.findByLabelText('Address'), 'https://example.test/r.git');
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

  it('offers no remote settings to someone who is not the owner', async () => {
    mockApi({
      remote: {
        url: 'https://example.test/r.git',
        username: null,
        hasToken: true,
        lastPushedAt: null,
        lastPulledAt: null,
      },
    });
    render(
      <ProjectBranches projectId={PROJECT} canWrite canManageRemote={false} onChanged={() => {}} />,
    );

    expect(await screen.findByRole('button', { name: 'Push main' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Address')).not.toBeInTheDocument();
  });
});
