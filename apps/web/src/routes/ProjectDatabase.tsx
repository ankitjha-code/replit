import { useEffect, useState } from 'react';
import type {
  DatabaseBackupSummary,
  DatabaseConnection,
  DatabaseStateResponse,
  ProjectDatabase as ProjectDatabaseRow,
} from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { formatBytes } from '../lib/format.js';
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
import { useAction } from '../lib/use-action.js';
import { useResource } from '../lib/use-resource.js';
import { Archive, ArrowClockwise, Database, Eye, EyeSlash, Trash } from '../ui/icons.js';
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  IconButton,
  Input,
  KeyValue,
  RelativeTime,
  SecretValue,
  SectionHeader,
  Spinner,
  Table,
  toast,
} from '../ui/index.js';
import { RestartCallout } from './settings/RestartCallout.js';
import './run/run.css';

/** How often a database that is still being made, or a backup still running, is read again. */
const POLL_MS = 3_000;

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
  const read = useResource((signal) => fetchProjectDatabase(projectId, signal), [projectId], {
    poll: (state) => (state.database?.status === 'CREATING' ? POLL_MS : null),
  });

  /*
   * Every action answers with the whole state. It replaces what was read until
   * the next read lands, so the page never shows a database the server has
   * just said is gone, and never patches what is on screen by hand.
   */
  const [override, setOverride] = useState<DatabaseStateResponse | undefined>();
  useEffect(() => setOverride(undefined), [read.data]);
  const state = override ?? read.data;
  const database = state?.database ?? null;
  const unavailable = state?.unavailableReason ?? null;

  const [revealed, setRevealed] = useState(false);
  const [confirming, setConfirming] = useState<'rotate' | 'reset' | 'delete' | undefined>();

  const create = useAction(() => createProjectDatabase(projectId));

  const adopt = (next: DatabaseStateResponse): void => {
    setOverride(next);
    read.reload();
  };

  const onCreate = async (): Promise<void> => {
    const outcome = await create.run();
    if (outcome.ok) adopt(outcome.value);
  };

  /**
   * The three ways a database changes after it exists. One handler, because
   * they differ only in which call they make and what they are called when
   * they fail; the confirm dialog shows the failure and offers a retry.
   */
  const act = async (
    action: 'rotate' | 'reset' | 'delete',
    call: () => Promise<DatabaseStateResponse>,
    failure: string,
  ): Promise<void> => {
    let next: DatabaseStateResponse;
    try {
      next = await call();
    } catch (cause) {
      throw new Error(cause instanceof ApiError ? cause.message : failure);
    }
    adopt(next);
    // A rotation produces a password nobody has seen, so it is shown at once
    // rather than hidden behind the button that hides an old one.
    if (action === 'rotate') setRevealed(true);
    if (action === 'delete') setRevealed(false);
    toast({
      tone: 'success',
      title:
        action === 'rotate'
          ? 'Password changed'
          : action === 'reset'
            ? 'Database emptied'
            : 'Database deleted',
    });
  };

  const loading = read.status === 'loading' && !state;
  const loadError =
    read.status === 'error' && !state
      ? read.error instanceof ApiError
        ? read.error.message
        : 'The database could not be loaded.'
      : undefined;

  return (
    <section className="run-section" aria-labelledby="database-heading">
      <SectionHeader
        title={<span id="database-heading">Database</span>}
        icon={Database}
        description="A PostgreSQL database of this project's own, on a separate server from the platform's. The app is started already knowing how to reach it."
        action={
          database?.status === 'READY' ? (
            <Badge tone="ok" dot>
              Ready
            </Badge>
          ) : database?.status === 'CREATING' ? (
            <Badge tone="info">Creating</Badge>
          ) : database?.status === 'FAILED' ? (
            <Badge tone="danger">Failed</Badge>
          ) : undefined
        }
      />

      {unavailable ? <Callout tone="info" title={unavailable} /> : null}

      {loadError ? (
        <Callout
          tone="danger"
          title={loadError}
          action={
            <Button size="sm" onClick={read.reload}>
              Retry
            </Button>
          }
        />
      ) : null}

      {loading ? <KeyValue items={[]} loading placeholderRows={4} /> : null}

      {!loading && !loadError && !database && !unavailable ? (
        <>
          {create.error ? (
            <Callout
              tone="danger"
              title={
                create.error instanceof ApiError
                  ? create.error.message
                  : 'The database could not be created.'
              }
            />
          ) : null}
          <EmptyState
            icon={Database}
            title="This project has no database."
            body="A PostgreSQL database of this project's own, reachable from the app as DATABASE_URL."
            action={
              <Button variant="primary" loading={create.busy} onClick={() => void onCreate()}>
                Create a database
              </Button>
            }
          />
        </>
      ) : null}

      {database?.status === 'FAILED' ? (
        // The reason is the provider's own, written to be shown.
        <Callout
          tone="danger"
          title={database.message ?? 'The database could not be created.'}
          action={
            <Button size="sm" loading={create.busy} onClick={() => void onCreate()}>
              Try again
            </Button>
          }
        />
      ) : null}

      {database?.status === 'CREATING' ? (
        <div className="run-status" role="status">
          <Spinner size={16} aria-hidden="true" />
          <span>The database is being created. This usually takes a few seconds.</span>
        </div>
      ) : null}

      {database?.status === 'READY' ? (
        <>
          {/* A container is handed its environment when it is created. After a
              rotation the credentials a running container holds do not merely
              differ, they no longer work. */}
          {state?.restartRequired ? (
            <RestartCallout projectId={projectId}>
              The environment is running with the details it started with. Restart it for changes
              here to take effect.
            </RestartCallout>
          ) : null}

          {database.connection ? (
            <Connection
              connection={database.connection}
              database={database}
              revealed={revealed}
              onToggleRevealed={() => setRevealed((current) => !current)}
            />
          ) : (
            <Callout
              tone="warn"
              title="The database exists, but its credentials could not be read."
            >
              Its password was encrypted with a key this installation no longer has. Changing the
              password writes a new one with the current key.
            </Callout>
          )}

          <div className="run-form__actions">
            <Button icon={ArrowClockwise} onClick={() => setConfirming('rotate')}>
              Change password
            </Button>
          </div>

          <Backups projectId={projectId} />

          <Card tone="danger" padding="md" className="run-danger">
            <h3 className="run-subsection__title">Danger zone</h3>
            <p className="run-subsection__text">
              Emptying keeps the database and its connection details but deletes every table and
              row. Deleting removes the database itself, and the project starts without one. Neither
              can be undone.
            </p>
            <div className="run-danger__actions">
              <Button variant="danger" onClick={() => setConfirming('reset')}>
                Empty database
              </Button>
              <Button variant="danger" icon={Trash} onClick={() => setConfirming('delete')}>
                Delete database
              </Button>
            </div>
          </Card>
        </>
      ) : null}

      <ConfirmDialog
        open={confirming === 'rotate'}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
        title="Change the database password?"
        body="A new password is generated and shown here. Anything using the old one stops connecting until it is given the new one; the app gets it when the environment restarts."
        confirmLabel="Change password"
        onConfirm={() =>
          act(
            'rotate',
            () => rotateProjectDatabasePassword(projectId),
            'The password could not be changed.',
          )
        }
      />
      <ConfirmDialog
        open={confirming === 'reset'}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
        tone="danger"
        title="Empty this database?"
        body="Everything stored in it will be deleted. The connection details stay the same. This cannot be undone."
        typeToConfirm="empty"
        confirmLabel="Empty database"
        onConfirm={() =>
          act('reset', () => resetProjectDatabase(projectId), 'The database could not be emptied.')
        }
      />
      <ConfirmDialog
        open={confirming === 'delete'}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
        tone="danger"
        title="Delete this database?"
        body="The database and everything in it will be deleted, and the project will start without one. This cannot be undone."
        typeToConfirm="delete"
        confirmLabel="Delete database"
        onConfirm={() =>
          act(
            'delete',
            () => deleteProjectDatabase(projectId),
            'The database could not be deleted.',
          )
        }
      />
    </section>
  );
}

/**
 * How to connect, in the two forms people actually use.
 *
 * A URL for a library, and the separate parts for a tool that asks for them one
 * at a time. Both are the same database; neither is a second source of truth.
 * Every value has a copy button, because every one of them gets pasted
 * somewhere.
 */
function Connection({
  connection,
  database,
  revealed,
  onToggleRevealed,
}: {
  connection: DatabaseConnection;
  database: ProjectDatabaseRow;
  revealed: boolean;
  onToggleRevealed: () => void;
}): React.JSX.Element {
  /*
   * The host is a container name, and it resolves only inside the project's own
   * container. Saying so stops somebody pasting it into a client on their laptop
   * and concluding the platform is broken.
   */
  return (
    <>
      <p className="run-note">
        These work from inside the project, where <code>{connection.host}</code> resolves. The app
        is started with them already set.
      </p>

      <KeyValue
        items={[
          { term: 'Host', value: connection.host, mono: true, copy: connection.host },
          {
            term: 'Port',
            value: String(connection.port),
            mono: true,
            copy: String(connection.port),
          },
          { term: 'Database', value: connection.database, mono: true, copy: connection.database },
          { term: 'User', value: connection.username, mono: true, copy: connection.username },
          {
            term: 'Password',
            value: (
              <span className="run-password">
                {/* Re-mounted on toggle so the mask and the text never coexist. */}
                <SecretValue
                  key={revealed ? 'shown' : 'hidden'}
                  value={connection.password}
                  masked={!revealed}
                  revealable={false}
                  name="password"
                />
                <IconButton
                  size="sm"
                  label={revealed ? 'Hide password' : 'Show password'}
                  icon={revealed ? EyeSlash : Eye}
                  aria-pressed={revealed}
                  onClick={onToggleRevealed}
                />
                <CopyButton value={connection.password} label="Copy password" />
              </span>
            ),
          },
          {
            term: 'Connection URL',
            value: (
              <code className="run-value">{revealed ? connection.url : maskedUrl(connection)}</code>
            ),
            copy: connection.url,
          },
          {
            term: 'Size',
            // Null means the size could not be read. Showing zero would be a
            // claim that the database is empty, which is a different thing.
            value: database.sizeBytes === null ? 'Unknown' : formatBytes(database.sizeBytes),
          },
          { term: 'Created', value: <RelativeTime value={database.createdAt} /> },
        ]}
      />
      <p className="run-note">
        The URL is what the app receives as <code>DATABASE_URL</code>.
      </p>
    </>
  );
}

/**
 * The connection URL with the password left out, rebuilt from its parts
 * rather than by searching the real URL for the password: a password that
 * happens to contain URL-special characters would otherwise slip through.
 */
function maskedUrl(connection: DatabaseConnection): string {
  const scheme = connection.url.split('://')[0] ?? 'postgresql';
  return `${scheme}://${connection.username}:${'•'.repeat(8)}@${connection.host}:${connection.port}/${connection.database}`;
}

/**
 * Copies of the database, taken and put back.
 *
 * Nothing here downloads. A dump is the whole contents of a database in one
 * file, and the server offers no route that hands one over. A backup exists to
 * be restored here.
 */
function Backups({ projectId }: { projectId: string }): React.JSX.Element {
  const listed = useResource((signal) => fetchDatabaseBackups(projectId, signal), [projectId], {
    poll: (backups) => (backups.some((backup) => backup.status === 'RUNNING') ? POLL_MS : null),
  });
  const backups = listed.data ?? [];
  const [note, setNote] = useState('');
  const [restoring, setRestoring] = useState<DatabaseBackupSummary | undefined>();
  const [removing, setRemoving] = useState<DatabaseBackupSummary | undefined>();

  const take = useAction(async () => {
    await createDatabaseBackup(projectId, note.trim() || undefined);
  });

  const onTake = async (): Promise<void> => {
    const outcome = await take.run();
    if (outcome.ok) {
      setNote('');
      toast({ tone: 'success', title: 'Backup taken' });
      listed.reload();
    }
  };

  const nameOf = (backup: DatabaseBackupSummary): string =>
    backup.note ?? `from ${new Date(backup.createdAt).toLocaleString()}`;

  return (
    <div className="run-subsection">
      <h3 className="run-subsection__title">Backups</h3>
      <p className="run-subsection__text">
        A copy of everything in this database, kept by the platform. Taking one can take a while for
        a large database. A backup is restored here; it cannot be downloaded.
      </p>

      <div className="run-inline-form">
        <Input
          aria-label="Backup note"
          placeholder="What is this backup for? (optional)"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={200}
          size="md"
        />
        <Button icon={Archive} loading={take.busy} onClick={() => void onTake()}>
          Take a backup
        </Button>
      </div>
      {take.error ? (
        <Callout
          tone="danger"
          title={
            take.error instanceof ApiError ? take.error.message : 'The backup could not be taken.'
          }
        />
      ) : null}

      <Table<DatabaseBackupSummary>
        caption="Database backups"
        density="dense"
        columns={[
          { key: 'name', header: 'Backup', cell: (backup) => nameOf(backup) },
          {
            key: 'status',
            header: 'Status',
            width: '140px',
            cell: (backup) =>
              backup.status === 'RUNNING' ? (
                <Badge tone="info" icon={<Spinner size={12} aria-hidden="true" />}>
                  Being taken
                </Badge>
              ) : backup.status === 'FAILED' ? (
                <Badge tone="danger">Failed</Badge>
              ) : (
                <Badge tone="ok">
                  {backup.sizeBytes === null ? 'Ready' : formatBytes(backup.sizeBytes)}
                </Badge>
              ),
          },
          {
            key: 'taken',
            header: 'Taken',
            cell: (backup) => (
              <>
                <RelativeTime value={backup.createdAt} />
                {backup.createdBy ? ` by ${backup.createdBy}` : ''}
                {backup.message ? (
                  <>
                    <br />
                    <span className="run-section__meta">{backup.message}</span>
                  </>
                ) : null}
              </>
            ),
          },
        ]}
        rows={backups}
        rowKey={(backup) => backup.id}
        rowName={(backup) => nameOf(backup)}
        rowActions={(backup) => [
          {
            label: 'Restore',
            icon: ArrowClockwise,
            onSelect: () => setRestoring(backup),
            ...(backup.status !== 'READY'
              ? {
                  disabledReason:
                    backup.status === 'RUNNING'
                      ? 'This backup is still being taken'
                      : 'This backup failed and cannot be restored',
                }
              : {}),
          },
          {
            label: 'Remove backup',
            icon: Trash,
            tone: 'danger',
            onSelect: () => setRemoving(backup),
            ...(backup.status === 'RUNNING'
              ? { disabledReason: 'This backup is still being taken' }
              : {}),
          },
        ]}
        loading={listed.status === 'loading'}
        {...(listed.status === 'error'
          ? {
              error:
                listed.error instanceof ApiError
                  ? listed.error.message
                  : 'The backups could not be loaded.',
              onRetry: listed.reload,
            }
          : {})}
        empty={{
          icon: Archive,
          title: 'No backups yet.',
          body: 'A backup is a copy of everything in the database that you can restore here.',
        }}
      />

      <ConfirmDialog
        open={restoring !== undefined}
        onOpenChange={(open) => {
          if (!open) setRestoring(undefined);
        }}
        tone="danger"
        title={`Restore the backup ${restoring ? nameOf(restoring) : ''}?`}
        // Says what is lost, not what is gained. "Restore" sounds like repair;
        // what this does is delete everything in the database and put this
        // copy there instead, and the dialog is the last place to say so.
        body="Everything in the database now is deleted and replaced with this backup. This cannot be undone."
        confirmLabel={`Restore ${restoring ? nameOf(restoring) : 'backup'}`}
        onConfirm={async () => {
          if (!restoring) return;
          try {
            await restoreDatabaseBackup(projectId, restoring.id);
          } catch (cause) {
            throw new Error(
              cause instanceof ApiError ? cause.message : 'The backup could not be restored.',
            );
          }
          toast({ tone: 'success', title: 'Backup restored' });
          listed.reload();
        }}
      />
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        tone="danger"
        title={`Remove the backup ${removing ? nameOf(removing) : ''}?`}
        body="The copy is deleted. The database itself is not touched."
        confirmLabel={`Remove backup ${removing ? nameOf(removing) : ''}`}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await deleteDatabaseBackup(projectId, removing.id);
          } catch (cause) {
            throw new Error(
              cause instanceof ApiError ? cause.message : 'The backup could not be removed.',
            );
          }
          toast({ tone: 'success', title: 'Backup removed' });
          listed.reload();
        }}
      />
    </div>
  );
}
