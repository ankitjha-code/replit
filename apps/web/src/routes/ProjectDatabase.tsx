import { useCallback, useEffect, useState } from 'react';
import type {
  DatabaseBackupSummary,
  DatabaseConnection,
  ProjectDatabase as ProjectDatabaseRow,
} from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import {
  createDatabaseBackup,
  createProjectDatabase,
  deleteDatabaseBackup,
  deleteProjectDatabase,
  fetchDatabaseBackups,
  fetchProjectDatabase,
  resetProjectDatabase,
  restoreDatabaseBackup,
  rotateProjectDatabasePassword,
} from '../lib/project-storage-api.js';

/**
 * The database a project's application gets.
 *
 * Shows the connection details, including the password, because it is the
 * project's own credential for the project's own data: an owner who cannot read
 * it cannot point a migration tool, a client or a dashboard at their own
 * database, which is most of what having one is for. The page is owner-only and
 * the password starts hidden, so reading it is deliberate rather than something
 * that happens over somebody's shoulder.
 */
export function ProjectDatabase({ projectId }: { projectId: string }): React.JSX.Element {
  const [database, setDatabase] = useState<ProjectDatabaseRow | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [revealed, setRevealed] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  /**
   * Which destructive action is waiting to be confirmed, if any.
   *
   * Emptying a database and removing one both destroy data that nothing else
   * holds a copy of, so neither happens on a single click.
   */
  const [confirming, setConfirming] = useState<'reset' | 'delete' | undefined>();

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const state = await fetchProjectDatabase(projectId, signal);
        if (signal?.aborted) return;
        setDatabase(state.database);
        setUnavailable(state.unavailableReason);
        setRestartRequired(state.restartRequired);
        setError(undefined);
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'The database could not be loaded.');
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

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const state = await createProjectDatabase(projectId);
      setDatabase(state.database);
      setRestartRequired(state.restartRequired);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The database could not be created.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * The three ways a database changes after it exists.
   *
   * One handler, because they differ only in which call they make and what they
   * are called when they fail. Each replaces the whole state from the answer
   * rather than patching what is on screen, so the page cannot drift from the
   * server.
   */
  const act = async (
    action: 'reset' | 'rotate' | 'delete',
    call: () => Promise<Awaited<ReturnType<typeof fetchProjectDatabase>>>,
    failure: string,
  ): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setConfirming(undefined);
    try {
      const state = await call();
      setDatabase(state.database);
      setRestartRequired(state.restartRequired);
      // A rotation produces a password nobody has seen, so it is shown at once
      // rather than hidden behind the button that hides an old one.
      if (action === 'rotate') setRevealed(true);
      if (action === 'delete') setRevealed(false);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="project-section" aria-labelledby="database-heading">
      <h2 id="database-heading">Database</h2>
      <p className="project-section__hint">
        A PostgreSQL database of this project&apos;s own, in a different server from the
        platform&apos;s. Your application is started already knowing how to reach it.
      </p>

      {unavailable && (
        <p className="project-section__error" role="status">
          {unavailable}
        </p>
      )}

      {error && (
        <p className="project-section__error" role="alert">
          {error}
        </p>
      )}

      {loading && <p className="project-section__note">Loading database…</p>}

      {!loading && !database && !unavailable && (
        <>
          <p className="project-section__note">This project has no database.</p>
          <button
            type="button"
            className="button-quiet"
            disabled={busy}
            onClick={() => void create()}
          >
            {busy ? 'Creating…' : 'Create a database'}
          </button>
        </>
      )}

      {database?.status === 'FAILED' && (
        <>
          {/* The reason is the provider's own, written to be shown. */}
          <p className="project-section__error" role="status">
            {database.message ?? 'The database could not be created.'}
          </p>
          <button
            type="button"
            className="button-quiet"
            disabled={busy}
            onClick={() => void create()}
          >
            {busy ? 'Trying again…' : 'Try again'}
          </button>
        </>
      )}

      {database?.status === 'CREATING' && (
        <p className="project-section__note" role="status">
          The database is being created.
        </p>
      )}

      {database?.status === 'READY' && (
        <>
          {/* A container is handed its environment when it is created. After a
              rotation the credentials a running container holds do not merely
              differ, they no longer work. */}
          {restartRequired && (
            <p className="project-section__note" role="status">
              The project is running with the details it started with. Restart it for changes here
              to take effect.
            </p>
          )}

          {database.connection && (
            <Connection
              connection={database.connection}
              sizeBytes={database.sizeBytes}
              revealed={revealed}
              onReveal={() => setRevealed(true)}
            />
          )}

          <div className="project-section__actions">
            <button
              type="button"
              className="button-quiet"
              disabled={busy}
              onClick={() =>
                void act(
                  'rotate',
                  () => rotateProjectDatabasePassword(projectId),
                  'The password could not be changed.',
                )
              }
            >
              {busy ? 'Working…' : 'Change password'}
            </button>

            {confirming === 'reset' ? (
              <>
                <button
                  type="button"
                  className="button-danger"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      'reset',
                      () => resetProjectDatabase(projectId),
                      'The database could not be reset.',
                    )
                  }
                >
                  Yes, delete everything in it
                </button>
                <button
                  type="button"
                  className="button-quiet"
                  onClick={() => setConfirming(undefined)}
                >
                  Keep it
                </button>
              </>
            ) : (
              <button
                type="button"
                className="button-quiet"
                disabled={busy}
                onClick={() => setConfirming('reset')}
              >
                Empty this database
              </button>
            )}

            {confirming === 'delete' ? (
              <>
                <button
                  type="button"
                  className="button-danger"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      'delete',
                      () => deleteProjectDatabase(projectId),
                      'The database could not be removed.',
                    )
                  }
                >
                  Yes, remove the database
                </button>
                <button
                  type="button"
                  className="button-quiet"
                  onClick={() => setConfirming(undefined)}
                >
                  Keep it
                </button>
              </>
            ) : (
              <button
                type="button"
                className="button-danger"
                disabled={busy}
                onClick={() => setConfirming('delete')}
              >
                Remove the database
              </button>
            )}
          </div>

          <Backups projectId={projectId} />

          {/* Said once, next to the buttons that do it, rather than in a
              tooltip somebody reads afterwards. */}
          {confirming && (
            <p className="project-section__error" role="status">
              {confirming === 'reset'
                ? 'Everything stored in this database will be deleted. The connection details stay the same. This cannot be undone.'
                : 'The database and everything in it will be deleted, and the project will start without one. This cannot be undone.'}
            </p>
          )}
        </>
      )}

      {database?.status === 'READY' && !database.connection && (
        <p className="project-section__error" role="status">
          The database exists, but its credentials could not be read. Its password was encrypted
          with a key this installation no longer has.
        </p>
      )}
    </section>
  );
}

/**
 * Copies of the database, taken and put back.
 *
 * Deliberately below the destructive buttons rather than above them. Somebody
 * arriving to empty or remove a database should see that a copy is possible on
 * their way past, and somebody who has come to take a copy is not in a hurry.
 *
 * **Nothing here downloads.** A dump is the whole contents of a database in one
 * file, and the server offers no route that hands one over. A backup exists to
 * be restored here.
 */
function Backups({ projectId }: { projectId: string }): React.JSX.Element {
  const [backups, setBackups] = useState<DatabaseBackupSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [confirming, setConfirming] = useState<string | undefined>();

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const listed = await fetchDatabaseBackups(projectId, signal);
        if (signal?.aborted) return;
        setBackups(listed);
      } catch {
        // Context, not the point of the page. The database itself still works.
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <div className="project-section">
      <h2>Backups</h2>
      <p className="project-section__hint">
        A copy of everything in this database, kept by the platform. Taking one runs a container and
        can take a while for a large database; there is no download, and a backup can only be put
        back here.
      </p>

      <div className="project-section__actions">
        <input
          className="input"
          type="text"
          placeholder="What is this copy for? (optional)"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={200}
        />
        <button
          type="button"
          className="button-quiet"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(undefined);

            createDatabaseBackup(projectId, note.trim() || undefined)
              .then(() => {
                setNote('');
                return load();
              })
              .catch((cause: unknown) => {
                setError(
                  cause instanceof ApiError ? cause.message : 'The copy could not be taken.',
                );
              })
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Copying…' : 'Take a copy now'}
        </button>
      </div>

      {error && <p className="project-section__error">{error}</p>}

      <ul className="project-section__list">
        {backups.map((backup) => (
          <li key={backup.id} className="project-section__item">
            <span className="project-section__item-name">
              {backup.note ?? new Date(backup.createdAt).toLocaleString()}
            </span>
            <span className="project-section__item-meta">
              {backup.status === 'READY' && backup.sizeBytes !== null
                ? `${formatBytes(backup.sizeBytes)} · taken ${new Date(backup.createdAt).toLocaleString()}`
                : backup.status === 'RUNNING'
                  ? 'being taken…'
                  : 'failed'}
              {backup.createdBy ? ` by ${backup.createdBy}` : ''}
            </span>

            {backup.message && (
              <span className="project-section__item-value">{backup.message}</span>
            )}

            {backup.status === 'READY' &&
              (confirming === backup.id ? (
                <>
                  <button
                    type="button"
                    className="button-danger"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      setConfirming(undefined);
                      setError(undefined);

                      restoreDatabaseBackup(projectId, backup.id)
                        .then(() => load())
                        .catch((cause: unknown) => {
                          setError(
                            cause instanceof ApiError
                              ? cause.message
                              : 'The backup could not be put back.',
                          );
                        })
                        .finally(() => setBusy(false));
                    }}
                  >
                    {/*
                     * Says what is lost, not what is gained.
                     *
                     * "Restore" sounds like repair. What this does is delete
                     * everything in the database and put this copy there
                     * instead, and the button is the last place to say so.
                     */}
                    Yes, replace everything with this copy
                  </button>
                  <button
                    type="button"
                    className="button-quiet"
                    onClick={() => setConfirming(undefined)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="icon-button"
                  disabled={busy}
                  onClick={() => setConfirming(backup.id)}
                >
                  Put this back
                </button>
              ))}

            <button
              type="button"
              className="icon-button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                deleteDatabaseBackup(projectId, backup.id)
                  .then(() => load())
                  .catch(() => setError('That copy could not be removed.'))
                  .finally(() => setBusy(false));
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      {backups.length === 0 && <p className="project-section__hint">No copies yet.</p>}
    </div>
  );
}

/**
 * How to connect, in the two forms people actually use.
 *
 * A URL for a library, and the separate parts for a tool that asks for them one
 * at a time. Both are the same database; neither is a second source of truth.
 */
function Connection({
  connection,
  sizeBytes,
  revealed,
  onReveal,
}: {
  connection: DatabaseConnection;
  sizeBytes: number | null;
  revealed: boolean;
  onReveal: () => void;
}): React.JSX.Element {
  /*
   * The host is a container name, and it resolves only inside the project's own
   * container. Saying so stops somebody pasting it into a client on their laptop
   * and concluding the platform is broken.
   */
  return (
    <>
      <p className="project-section__note">
        These work from inside the project, where <code>{connection.host}</code> resolves. Your
        application is started with them already set.
      </p>

      <dl className="project-section__facts">
        <div>
          <dt>Host</dt>
          <dd>{connection.host}</dd>
        </div>
        <div>
          <dt>Port</dt>
          <dd>{connection.port}</dd>
        </div>
        <div>
          <dt>Database</dt>
          <dd>{connection.database}</dd>
        </div>
        <div>
          <dt>User</dt>
          <dd>{connection.username}</dd>
        </div>
        <div>
          <dt>Size</dt>
          {/* Null means the size could not be read. Showing zero would be a
              claim that the database is empty, which is a different thing. */}
          <dd>{sizeBytes === null ? 'unknown' : formatBytes(sizeBytes)}</dd>
        </div>
        <div>
          <dt>Password</dt>
          <dd>
            {revealed ? (
              connection.password
            ) : (
              <button type="button" className="icon-button" onClick={onReveal}>
                Show password
              </button>
            )}
          </dd>
        </div>
      </dl>

      <p className="project-section__note">
        Connection URL, as <code>DATABASE_URL</code>:
      </p>
      <p className="project-section__item-value">
        {revealed
          ? connection.url
          : connection.url.replace(`:${connection.password}@`, ':••••••••@')}
      </p>
    </>
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
