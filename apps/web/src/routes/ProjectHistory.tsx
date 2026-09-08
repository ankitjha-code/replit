import { useCallback, useEffect, useState } from 'react';
import type { GitChange, GitCommit, RestoreResult } from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { fieldErrorsFrom } from '../lib/form-errors.js';
import { commitProject, fetchCommit, fetchGitState, restoreCommit } from '../lib/git-api.js';

/**
 * A project's history, as git records it.
 *
 * The distinction from snapshots, which sit above this on the page, is worth
 * being plain about: a snapshot is a whole copy kept as a thing to go back to,
 * and a commit is a step in a line of them. Somebody who wants "the version
 * before I broke it" wants a snapshot; somebody who wants to see how a project
 * arrived where it is wants this.
 */
export function ProjectHistory({
  projectId,
  canWrite,
  reloadNonce = 0,
}: {
  projectId: string;
  canWrite: boolean;
  /** Bumped when branches or a pull changed history elsewhere on the page. */
  reloadNonce?: number;
}): React.JSX.Element {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [pending, setPending] = useState<GitChange[]>([]);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [message, setMessage] = useState('');
  const [expanded, setExpanded] = useState<string | undefined>();
  const [changes, setChanges] = useState<Record<string, GitChange[]>>({});
  /** Which commit is being asked about before its files are put back. */
  const [restoring, setRestoring] = useState<string | undefined>();
  const [restored, setRestored] = useState<RestoreResult | undefined>();

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const state = await fetchGitState(projectId, signal);
        if (signal?.aborted) return;
        setCommits(state.commits);
        setPending(state.pendingChanges);
        setUnavailable(state.unavailableReason);
        setError(undefined);
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'The history could not be loaded.');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reloadNonce]);

  const commit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    try {
      const state = await commitProject(projectId, message);
      setMessage('');
      setCommits(state.commits);
      setPending(state.pendingChanges);
    } catch (cause) {
      const { fields, message: general } = fieldErrorsFrom(cause);
      setError(
        fields.message ??
          general ??
          (cause instanceof ApiError ? cause.message : 'The commit could not be made.'),
      );
    } finally {
      setBusy(false);
    }
  };

  /**
   * Puts the project's files back to what a commit contained.
   *
   * Not a checkout, and the wording says so: the branch does not move and
   * nothing is detached. What was there before is kept as a snapshot, and the
   * change back becomes the next commit.
   */
  const restore = async (oid: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setRestored(undefined);
    setRestoring(undefined);

    try {
      const result = await restoreCommit(projectId, oid);
      setRestored(result);
      // The files changed, so what is waiting to be committed changed with them.
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The project could not be restored.');
    } finally {
      setBusy(false);
    }
  };

  /** Fetches what a commit changed, the first time it is opened. */
  const toggle = async (oid: string): Promise<void> => {
    if (expanded === oid) {
      setExpanded(undefined);
      return;
    }
    setExpanded(oid);
    if (changes[oid]) return;

    try {
      const detail = await fetchCommit(projectId, oid);
      setChanges((held) => ({ ...held, [oid]: detail.changes }));
    } catch {
      // Left unexpanded rather than shown as an error: the history itself is
      // still perfectly readable, and this is a detail somebody asked for.
      setChanges((held) => ({ ...held, [oid]: [] }));
    }
  };

  return (
    <section className="project-section" aria-labelledby="history-heading">
      <h2 id="history-heading">History</h2>
      <p className="project-section__hint">
        A real git repository, kept beside this project. Commits are made from the files as they are
        now. Restoring a commit puts the files back to what it held and leaves the branch where it
        is, so going back is recorded as the next commit rather than hidden. Branches and a remote
        to push to are below.
      </p>

      {unavailable && (
        <p className="project-section__error" role="status">
          {unavailable}
        </p>
      )}

      {!unavailable && canWrite && (
        <form className="project-section__form" onSubmit={(event) => void commit(event)}>
          <label htmlFor="commit-message">Commit message</label>
          <input
            id="commit-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="What changed"
            autoComplete="off"
            required
          />

          <button type="submit" className="button-quiet" disabled={busy || pending.length === 0}>
            {busy ? 'Committing…' : 'Commit'}
          </button>
        </form>
      )}

      {/* Said before the button is pressed. Committing nothing is refused by
          the server, and finding that out by pressing is worse than reading it. */}
      {!unavailable && !loading && pending.length === 0 && (
        <p className="project-section__note">
          {commits.length === 0
            ? 'Nothing has been committed yet, and there is nothing to commit.'
            : 'Nothing has changed since the last commit.'}
        </p>
      )}

      {pending.length > 0 && (
        <>
          <p className="project-section__note">
            {pending.length} {pending.length === 1 ? 'file' : 'files'} would go into the next
            commit:
          </p>
          <Changes changes={pending} />
        </>
      )}

      {error && (
        <p className="project-section__error" role="alert">
          {error}
        </p>
      )}

      {restored && (
        <p className="project-section__note" role="status">
          Restored {restored.label}: {describeCounts(restored)}.
          {restored.safetySnapshot
            ? ` What was here before was kept as the snapshot "${restored.safetySnapshot.name}".`
            : ''}
        </p>
      )}

      {loading && <p className="project-section__note">Loading history…</p>}

      {commits.length > 0 && (
        <ul className="project-section__list">
          {commits.map((entry) => (
            <li key={entry.oid} className="project-section__item">
              <span className="project-section__item-name">{entry.message}</span>
              <span className="project-section__item-meta">
                {/* Seven characters, which is what git itself shows and what a
                    person would type. */}
                {entry.oid.slice(0, 7)}
              </span>
              <span className="project-section__item-meta">
                {entry.authorName}, {new Date(entry.timestamp * 1000).toLocaleString()}
              </span>
              <button type="button" className="icon-button" onClick={() => void toggle(entry.oid)}>
                {expanded === entry.oid ? 'Hide changes' : 'Show changes'}
              </button>

              {canWrite &&
                (restoring === entry.oid ? (
                  <>
                    <span className="project-section__item-value">
                      This replaces every file in the project with what this commit held. Stop the
                      project first if it is running.
                    </span>
                    <button
                      type="button"
                      className="button-danger"
                      disabled={busy}
                      onClick={() => void restore(entry.oid)}
                    >
                      Yes, replace the files
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => setRestoring(undefined)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="icon-button"
                    disabled={busy}
                    onClick={() => setRestoring(entry.oid)}
                  >
                    Restore these files
                  </button>
                ))}

              {expanded === entry.oid && <Changes changes={changes[entry.oid] ?? []} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A list of paths and what happened to each. */
function Changes({ changes }: { changes: GitChange[] }): React.JSX.Element {
  if (changes.length === 0) {
    return <p className="project-section__note">No file changes.</p>;
  }

  return (
    <ul className="project-section__changes">
      {changes.map((change) => (
        <li key={`${change.kind}:${change.path}`}>
          {/* The word, not a symbol. A plus and a minus in a column are only
              obvious to somebody who already knows what they mean. */}
          <span className={`project-section__change project-section__change--${change.kind}`}>
            {change.kind}
          </span>{' '}
          {change.path}
        </li>
      ))}
    </ul>
  );
}

/** What a restore changed, in the words a person would use. */
function describeCounts(result: RestoreResult): string {
  const parts = [
    result.created > 0 ? `${result.created} added` : undefined,
    result.updated > 0 ? `${result.updated} changed` : undefined,
    result.deleted > 0 ? `${result.deleted} removed` : undefined,
  ].filter((part): part is string => part !== undefined);

  return parts.length === 0 ? 'nothing changed' : parts.join(', ');
}
