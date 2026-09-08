import { useCallback, useEffect, useState } from 'react';
import type { RestoreFileResponse, RestoreResult, SnapshotSummary } from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { writeFile } from '../lib/files-api.js';
import { fieldErrorsFrom } from '../lib/form-errors.js';
import {
  createSnapshot,
  deleteSnapshot,
  fetchSnapshots,
  restoreFileFromSnapshot,
  restoreSnapshot,
  snapshotArchiveUrl,
} from '../lib/project-storage-api.js';

/**
 * A project's snapshots.
 *
 * Editing is continuous and saves itself, so there is no moment at which a
 * project is "as it was this morning" unless somebody wrote one down. This is
 * where they write one down, and where they find it again.
 *
 * Restoring one replaces every file in the project, so it asks first, and it
 * says afterwards what the platform kept so the restore can be undone. A
 * destructive action whose undo is not mentioned is a destructive action that
 * looks permanent.
 */
export function ProjectSnapshots({
  projectId,
  canWrite,
}: {
  projectId: string;
  canWrite: boolean;
}): React.JSX.Element {
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [limit, setLimit] = useState(0);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [confirming, setConfirming] = useState<string | undefined>();
  /** Which snapshot is being asked about before it is restored over the project. */
  const [restoring, setRestoring] = useState<string | undefined>();
  const [restored, setRestored] = useState<RestoreResult | undefined>();

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const listed = await fetchSnapshots(projectId, signal);
        if (signal?.aborted) return;
        setSnapshots(listed.snapshots);
        setLimit(listed.limit);
        setUnavailable(listed.unavailableReason);
        setError(undefined);
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'The snapshots could not be loaded.');
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
  }, [load]);

  const take = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    try {
      await createSnapshot(projectId, description ? { name, description } : { name });
      setName('');
      setDescription('');
      await load();
    } catch (cause) {
      const { fields, message } = fieldErrorsFrom(cause);
      setError(
        fields.name ??
          fields.description ??
          message ??
          (cause instanceof ApiError ? cause.message : 'The snapshot could not be taken.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const restore = async (snapshot: SnapshotSummary): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setRestored(undefined);
    setRestoring(undefined);

    try {
      const result = await restoreSnapshot(projectId, snapshot.id);
      setRestored(result);
      // The list changes: the platform has just taken one of its own.
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The project could not be restored.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (snapshot: SnapshotSummary): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setConfirming(undefined);
    try {
      await deleteSnapshot(projectId, snapshot.id);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The snapshot could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  const full = snapshots.length >= limit && limit > 0;

  return (
    <section className="project-section" aria-labelledby="snapshots-heading">
      <h2 id="snapshots-heading">Snapshots</h2>
      <p className="project-section__hint">
        A named copy of every file in this project, kept as it was at the moment you took it.
        Downloading one gives you a <code>.tar</code> archive. Restoring one replaces every file in
        the project with what it holds, so the platform takes a snapshot of what is there first and
        tells you which one.
      </p>

      {unavailable && (
        <p className="project-section__error" role="status">
          {unavailable}
        </p>
      )}

      {!unavailable && canWrite && (
        <form className="project-section__form" onSubmit={(event) => void take(event)}>
          <label htmlFor="snapshot-name">Snapshot name</label>
          <input
            id="snapshot-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Before the rewrite"
            autoComplete="off"
            required
          />

          <label htmlFor="snapshot-description">Snapshot note</label>
          <input
            id="snapshot-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Optional"
            autoComplete="off"
          />

          <button type="submit" className="button-quiet" disabled={busy || full}>
            {busy ? 'Taking…' : 'Take a snapshot'}
          </button>
        </form>
      )}

      {/* Said before the button is pressed, not after it fails. */}
      {full && (
        <p className="project-section__note" role="status">
          This project has its limit of {limit} snapshots. Remove one to take another.
        </p>
      )}

      {error && (
        <p className="project-section__error" role="alert">
          {error}
        </p>
      )}

      {/* What the restore actually did, and the way back from it. */}
      {restored && (
        <p className="project-section__note" role="status">
          Restored {restored.label}: {describeCounts(restored)}.
          {restored.safetySnapshot
            ? ` What was here before was kept as "${restored.safetySnapshot.name}", so this can be undone.`
            : ''}
        </p>
      )}

      {loading && <p className="project-section__note">Loading snapshots…</p>}

      {!loading && snapshots.length === 0 && (
        <p className="project-section__note">No snapshots yet.</p>
      )}

      {snapshots.length > 0 && (
        <ul className="project-section__list">
          {snapshots.map((snapshot) => (
            <li key={snapshot.id} className="project-section__item">
              <span className="project-section__item-name">{snapshot.name}</span>
              <span className="project-section__item-meta">
                {snapshot.fileCount} {snapshot.fileCount === 1 ? 'entry' : 'entries'},{' '}
                {formatBytes(snapshot.sizeBytes)}
              </span>
              <span className="project-section__item-meta">
                {new Date(snapshot.createdAt).toLocaleString()}
                {snapshot.createdBy ? ` by ${snapshot.createdBy}` : ''}
                {/* Said plainly, because these appear without anybody asking
                    for them and an unexplained snapshot is a confusing one. */}
                {snapshot.kind === 'AUTOMATIC' ? ' — taken automatically before a restore' : ''}
              </span>
              {snapshot.description && (
                <span className="project-section__item-value">{snapshot.description}</span>
              )}

              {/* A link rather than a fetch: the browser streams it to disk
                  instead of the page holding a whole project in memory. */}
              <a className="icon-button" href={snapshotArchiveUrl(projectId, snapshot.id)} download>
                Download
              </a>

              {canWrite &&
                (restoring === snapshot.id ? (
                  <>
                    <button
                      type="button"
                      className="button-danger"
                      disabled={busy}
                      onClick={() => void restore(snapshot)}
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
                    onClick={() => {
                      setConfirming(undefined);
                      setRestoring(snapshot.id);
                    }}
                  >
                    Restore
                  </button>
                ))}

              {restoring === snapshot.id && (
                <span className="project-section__item-value">
                  This replaces every file in the project with this snapshot. Stop the project first
                  if it is running.
                </span>
              )}

              {canWrite && <RestoreOneFile projectId={projectId} snapshotId={snapshot.id} />}

              {canWrite &&
                (confirming === snapshot.id ? (
                  <>
                    <button
                      type="button"
                      className="button-danger"
                      disabled={busy}
                      onClick={() => void remove(snapshot)}
                    >
                      Yes, delete it
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => setConfirming(undefined)}
                    >
                      Keep it
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="icon-button"
                    disabled={busy}
                    onClick={() => {
                      setRestoring(undefined);
                      setConfirming(snapshot.id);
                    }}
                  >
                    Remove
                  </button>
                ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Bytes, in the unit a person would say out loud. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** What a restore changed, in the words a person would use. */
function describeCounts(result: RestoreResult): string {
  const parts = [
    result.created > 0 ? `${result.created} added` : undefined,
    result.updated > 0 ? `${result.updated} changed` : undefined,
    result.deleted > 0 ? `${result.deleted} removed` : undefined,
  ].filter((part): part is string => part !== undefined);

  // "Nothing changed" is a real answer and worth saying: it means the project
  // already was what was being restored.
  return parts.length === 0 ? 'nothing changed' : parts.join(', ');
}

/**
 * One file back from a snapshot, rather than the whole project.
 *
 * No need to stop the project first, and no snapshot taken first: this is an
 * edit whose content comes from history. What the file held is kept, so the
 * undo is one click and puts exactly that back.
 */
function RestoreOneFile({
  projectId,
  snapshotId,
}: {
  projectId: string;
  snapshotId: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [undo, setUndo] = useState<RestoreFileResponse | undefined>();

  if (!open) {
    return (
      <button type="button" className="icon-button" onClick={() => setOpen(true)}>
        Put back one file…
      </button>
    );
  }

  return (
    <span className="project-section__item-value">
      <input
        className="input"
        placeholder="path/to/file.ts"
        value={path}
        onChange={(event) => setPath(event.target.value)}
      />
      <button
        type="button"
        className="icon-button"
        disabled={busy || path.trim() === ''}
        onClick={() => {
          setBusy(true);
          setError(undefined);
          setMessage(undefined);
          restoreFileFromSnapshot(projectId, snapshotId, path.trim())
            .then((result) => {
              setUndo(result);
              setMessage(`${result.path} is back to how it was in this snapshot.`);
            })
            .catch((cause: unknown) => {
              setError(
                cause instanceof ApiError ? cause.message : 'That file could not be put back.',
              );
            })
            .finally(() => setBusy(false));
        }}
      >
        Put it back
      </button>

      {message && <span className="project-section__note">{message}</span>}

      {undo?.previous && (
        <button
          type="button"
          className="icon-button"
          disabled={busy}
          onClick={() => {
            const previous = undo.previous;
            if (!previous) return;
            setBusy(true);
            writeFile(projectId, {
              path: undo.path,
              content: previous.content,
              encoding: previous.encoding,
            })
              .then(() => {
                setMessage(`${undo.path} is back to what it was before.`);
                setUndo(undefined);
              })
              .catch(() => setError('The change could not be undone.'))
              .finally(() => setBusy(false));
          }}
        >
          Undo
        </button>
      )}

      {error && <span className="project-section__error">{error}</span>}
    </span>
  );
}
