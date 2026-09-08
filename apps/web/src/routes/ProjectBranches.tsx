import { useCallback, useEffect, useState } from 'react';
import type { GitBranch, GitRemote } from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { fieldErrorsFrom } from '../lib/form-errors.js';
import {
  createBranch,
  deleteBranch,
  fetchGitState,
  fetchRemote,
  mergeBranch,
  pullFromRemote,
  pushToRemote,
  removeRemote,
  setRemote,
  switchBranch,
} from '../lib/git-api.js';

const OUTCOMES: Record<string, string> = {
  fastForward: 'Brought in by moving forward; no merge commit was needed.',
  merged: 'Merged, with a merge commit.',
  upToDate: 'Nothing to bring in: already up to date.',
  imported: 'Imported the remote’s history into this project.',
};

/**
 * Branches, and the one remote a project can push to and pull from.
 *
 * The project's files are the current branch. Switching and merging change
 * them, so both are refused while anything is uncommitted — the server says so,
 * and this page repeats it rather than offering a button that will fail.
 */
export function ProjectBranches({
  projectId,
  canWrite,
  canManageRemote,
  onChanged,
}: {
  projectId: string;
  canWrite: boolean;
  /** The owner, who alone may set the remote's credentials. */
  canManageRemote: boolean;
  onChanged: () => void;
}): React.JSX.Element | null {
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [current, setCurrent] = useState('main');
  const [initialized, setInitialized] = useState(false);
  const [uncommitted, setUncommitted] = useState(false);
  const [remote, setRemoteState] = useState<GitRemote | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [newBranch, setNewBranch] = useState('');
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [state, loadedRemote] = await Promise.all([
          fetchGitState(projectId, signal),
          fetchRemote(projectId, signal),
        ]);
        if (signal?.aborted) return;
        setBranches(state.branches);
        setCurrent(state.branch);
        setInitialized(state.initialized);
        setUncommitted(state.hasUncommittedChanges);
        setUnavailable(state.unavailableReason);
        setRemoteState(loadedRemote);
        if (loadedRemote) {
          setUrl(loadedRemote.url);
          setUsername(loadedRemote.username ?? '');
        }
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'Branches could not be loaded.');
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /** Runs one action, then reloads this panel and tells the history above. */
  const act = async (work: () => Promise<string | undefined>, fallback: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setNotice(await work());
      await load();
      onChanged();
    } catch (cause) {
      const { fields, message } = fieldErrorsFrom(cause);
      setError(
        fields.name ??
          fields.url ??
          message ??
          (cause instanceof ApiError ? cause.message : fallback),
      );
    } finally {
      setBusy(false);
    }
  };

  if (unavailable) return null;

  const others = branches.filter((branch) => !branch.current);

  return (
    <section className="project-section" aria-labelledby="branches-heading">
      <h2 id="branches-heading">Branches and remote</h2>
      <p className="project-section__hint">
        The project&apos;s files are the branch you are on. Switching or merging changes them, so
        commit first; nothing uncommitted is ever overwritten.
      </p>

      {initialized && (
        <p className="project-section__note">
          On <strong>{current}</strong>
          {uncommitted ? ' — with uncommitted changes.' : '.'}
        </p>
      )}

      {canWrite && initialized && (
        <form
          className="project-section__form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await createBranch(projectId, newBranch);
              setNewBranch('');
              return `Branch ${newBranch} made from ${current}.`;
            }, 'The branch could not be made.');
          }}
        >
          <label htmlFor="new-branch">New branch from {current}</label>
          <input
            id="new-branch"
            value={newBranch}
            onChange={(event) => setNewBranch(event.target.value)}
            placeholder="feature/login"
            autoComplete="off"
            required
          />
          <button type="submit" className="button-quiet" disabled={busy}>
            Make branch
          </button>
        </form>
      )}

      {others.length > 0 && (
        <ul className="project-section__list">
          {others.map((branch) => (
            <li key={branch.name} className="project-section__item">
              <span className="project-section__item-name">{branch.name}</span>
              <span className="project-section__item-meta">{branch.headOid.slice(0, 7)}</span>
              {canWrite && (
                <>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={busy || uncommitted}
                    onClick={() =>
                      void act(async () => {
                        await switchBranch(projectId, branch.name);
                        return `Switched to ${branch.name}. The files are now that branch’s.`;
                      }, 'Could not switch branch.')
                    }
                  >
                    Switch to
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={busy || uncommitted}
                    onClick={() =>
                      void act(async () => {
                        const { merge } = await mergeBranch(projectId, branch.name);
                        return OUTCOMES[merge.outcome];
                      }, 'Could not merge.')
                    }
                  >
                    Merge into {current}
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await deleteBranch(projectId, branch.name);
                        return `Branch ${branch.name} deleted.`;
                      }, 'Could not delete the branch.')
                    }
                  >
                    Delete
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="project-section__subheading">Remote</h3>

      {remote ? (
        <p className="project-section__note">
          {remote.url}
          {remote.hasToken ? ' · with a stored token' : ' · no token'}
          {remote.lastPushedAt ? ` · pushed ${new Date(remote.lastPushedAt).toLocaleString()}` : ''}
          {remote.lastPulledAt ? ` · pulled ${new Date(remote.lastPulledAt).toLocaleString()}` : ''}
        </p>
      ) : (
        <p className="project-section__note">No remote. Add one to push this history somewhere.</p>
      )}

      {canManageRemote && (
        <form
          className="project-section__form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await setRemote(projectId, {
                url,
                ...(username.trim() ? { username: username.trim() } : {}),
                // Blank keeps what is stored; the token is never shown to be edited.
                ...(token ? { token } : {}),
              });
              setToken('');
              return 'Remote saved.';
            }, 'The remote could not be saved.');
          }}
        >
          <label htmlFor="remote-url">Address</label>
          <input
            id="remote-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://github.com/you/project.git"
            autoComplete="off"
            required
          />
          <label htmlFor="remote-username">Username (optional)</label>
          <input
            id="remote-username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="off"
          />
          <label htmlFor="remote-token">
            {remote?.hasToken ? 'Replace token (blank keeps it)' : 'Access token (optional)'}
          </label>
          <input
            id="remote-token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="new-password"
          />
          <button type="submit" className="button-quiet" disabled={busy}>
            Save remote
          </button>
          {remote && (
            <button
              type="button"
              className="button-quiet"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await removeRemote(projectId);
                  setUrl('');
                  setUsername('');
                  return 'Remote removed.';
                }, 'The remote could not be removed.')
              }
            >
              Remove remote
            </button>
          )}
        </form>
      )}

      {remote && canWrite && (
        <div className="project-section__actions">
          <button
            type="button"
            className="button-quiet"
            disabled={busy || !initialized}
            onClick={() =>
              void act(async () => {
                await pushToRemote(projectId);
                return `Pushed ${current}.`;
              }, 'Could not push.')
            }
          >
            Push {current}
          </button>
          <button
            type="button"
            className="button-quiet"
            disabled={busy || uncommitted}
            onClick={() =>
              void act(async () => {
                const { outcome } = await pullFromRemote(projectId);
                return OUTCOMES[outcome] ?? 'Pulled.';
              }, 'Could not pull.')
            }
          >
            Pull
          </button>
        </div>
      )}

      {notice && (
        <p className="project-section__note" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="project-section__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
