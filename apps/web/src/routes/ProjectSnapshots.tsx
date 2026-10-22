import { useState, type FormEvent } from 'react';
import type { RestoreResult, SnapshotSummary } from '@platform/shared';
import { Field } from '../components/Field.js';
import { fieldErrorsFrom } from '../lib/form-errors.js';
import { describeCounts, formatBytes, formatCount } from '../lib/format.js';
import {
  createSnapshot,
  deleteSnapshot,
  fetchSnapshots,
  restoreFileFromSnapshot,
  restoreSnapshot,
  snapshotArchiveUrl,
} from '../lib/project-storage-api.js';
import { useAction } from '../lib/use-action.js';
import { useResource } from '../lib/use-resource.js';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  RelativeTime,
  SectionHeader,
  Table,
  VisuallyHidden,
  toast,
  type Tone,
} from '../ui/index.js';
import { Archive, ArrowClockwise, DownloadSimple, FileText, Trash } from '../ui/icons.js';
import { RestoreFileDialog } from './safety/RestoreFileDialog.js';
import { RestoredFileCallout, type RestoredFile } from './safety/restore-file.js';
import { StopFirstDialog } from './settings/StopFirstDialog.js';
import './safety/safety.css';

const KIND_WORDS: Record<SnapshotSummary['kind'], { word: string; tone: Tone }> = {
  MANUAL: { word: 'Manual', tone: 'neutral' },
  AUTOMATIC: { word: 'Before a restore', tone: 'info' },
  DEPLOYMENT: { word: 'Deployment', tone: 'accent' },
};

export function ProjectSnapshots({
  projectId,
  canWrite,
}: {
  projectId: string;
  canWrite: boolean;
}): React.JSX.Element {
  const list = useResource((signal) => fetchSnapshots(projectId, signal), [projectId]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const [restoring, setRestoring] = useState<SnapshotSummary | undefined>();
  const [deleting, setDeleting] = useState<SnapshotSummary | undefined>();
  const [pickingFile, setPickingFile] = useState<SnapshotSummary | undefined>();
  const [restored, setRestored] = useState<RestoreResult | undefined>();
  const [restoredFile, setRestoredFile] = useState<RestoredFile | undefined>();

  const take = useAction(() =>
    createSnapshot(
      projectId,
      description.trim()
        ? { name: name.trim(), description: description.trim() }
        : { name: name.trim() },
    ),
  );

  const data = list.data;
  const snapshots = data?.snapshots ?? [];
  const limit = data?.limit ?? 0;
  const unavailable = data?.unavailableReason ?? null;
  const manualCount = snapshots.filter((snapshot) => snapshot.kind === 'MANUAL').length;
  const full = limit > 0 && manualCount >= limit;
  const fullReason = full
    ? `This project has its limit of ${limit} snapshots. Delete one to take another.`
    : undefined;
  const reasonId = 'snapshot-reason';

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (name.trim() === '') {
      setNameError('Give the snapshot a name');
      document.getElementById('snapshot-name')?.focus();
      return;
    }
    setNameError(undefined);
    const outcome = await take.run();
    if (outcome.ok) {
      toast({ tone: 'success', title: 'Snapshot taken', description: name.trim() });
      setName('');
      setDescription('');
      list.reload();
    }
  };

  const failure = take.error ? fieldErrorsFrom(take.error) : undefined;
  const nameFieldError = nameError ?? failure?.fields.name;
  const noteFieldError = failure?.fields.description;
  const generalError = nameFieldError || noteFieldError ? undefined : failure?.message;

  return (
    <section className="safety-section" aria-label="Snapshots">
      <SectionHeader
        title="Snapshots"
        icon={Archive}
        {...(snapshots.length > 0 ? { count: snapshots.length } : {})}
        description={
          limit > 0
            ? `A named copy of every file, kept as it was when you took it. ${manualCount} of ${limit} used.`
            : 'A named copy of every file, kept as it was when you took it.'
        }
        help={
          <>
            <p>
              Downloading one gives you a .tar archive. Restoring one replaces every file in the
              project with what it holds, so the platform takes a snapshot of what is there first
              and tells you which one.
            </p>
            <p>
              Snapshots taken before a restore and the ones a deployment was built from do not count
              against the limit.
            </p>
          </>
        }
      />

      {unavailable ? (
        <Callout tone="info" title="Snapshots are not available on this installation.">
          {unavailable}
        </Callout>
      ) : null}

      {data && !unavailable && canWrite ? (
        <form className="safety-form" onSubmit={(event) => void submit(event)} noValidate>
          <Field
            id="snapshot-name"
            label="Snapshot name"
            value={name}
            placeholder="Before the rewrite"
            autoComplete="off"
            maxLength={100}
            required
            error={nameFieldError}
            onChange={(event) => {
              setName(event.target.value);
              if (nameError) setNameError(undefined);
              if (take.error) take.reset();
            }}
          />
          <Field
            id="snapshot-description"
            label="Note (optional)"
            value={description}
            placeholder="Why this moment is worth keeping"
            autoComplete="off"
            maxLength={500}
            error={noteFieldError}
            onChange={(event) => {
              setDescription(event.target.value);
              if (take.error) take.reset();
            }}
          />
          <div className="safety-form__actions">
            <Button
              type="submit"
              variant="primary"
              loading={take.busy}
              loadingLabel="Taking the snapshot"
              disabled={full}
              aria-describedby={fullReason ? reasonId : undefined}
            >
              Take a snapshot
            </Button>
            {fullReason ? (
              <p id={reasonId} className="safety-form__reason">
                {fullReason}
              </p>
            ) : null}
          </div>
          {generalError ? <Callout tone="danger" title={generalError} /> : null}
        </form>
      ) : null}

      {restored ? (
        <Callout
          tone="ok"
          title={`Restored ${restored.label}: ${describeCounts(restored)}.`}
          onDismiss={() => setRestored(undefined)}
          action={
            restored.safetySnapshot && canWrite ? (
              <Button
                size="sm"
                onClick={() => {
                  if (restored.safetySnapshot) setRestoring(restored.safetySnapshot);
                }}
              >
                Undo
              </Button>
            ) : undefined
          }
        >
          {restored.safetySnapshot
            ? `What was here before was kept as "${restored.safetySnapshot.name}". Undo restores it.`
            : 'No snapshot of the previous files could be taken first.'}
        </Callout>
      ) : null}

      {restoredFile ? (
        <RestoredFileCallout
          projectId={projectId}
          restored={restoredFile}
          onDismiss={() => setRestoredFile(undefined)}
        />
      ) : null}

      {!unavailable ? (
        <Table
          caption="Snapshots of this project"
          rows={snapshots}
          rowKey={(snapshot) => snapshot.id}
          rowName={(snapshot) => `snapshot ${snapshot.name}`}
          loading={list.status === 'loading' && !data}
          placeholderRows={2}
          {...(list.status === 'error' && !data
            ? {
                error: list.error?.message ?? 'The snapshots could not be loaded.',
                onRetry: list.reload,
              }
            : {})}
          empty={{
            icon: Archive,
            title: 'No snapshots yet.',
            body: canWrite
              ? 'A snapshot is a named copy of every file that you can restore. Take the first one above.'
              : 'A snapshot is a named copy of every file that an editor can restore.',
          }}
          columns={[
            {
              key: 'name',
              header: 'Snapshot',
              cell: (snapshot) => (
                <div className="safety-cell">
                  <span className="safety-cell__title">
                    <span>{snapshot.name}</span>
                    <Badge tone={KIND_WORDS[snapshot.kind].tone}>
                      {KIND_WORDS[snapshot.kind].word}
                    </Badge>
                  </span>
                  {snapshot.description ? (
                    <span className="safety-cell__detail">{snapshot.description}</span>
                  ) : null}
                </div>
              ),
            },
            {
              key: 'size',
              header: 'Size',
              cell: (snapshot) => (
                <span className="safety-nowrap">
                  {formatBytes(snapshot.sizeBytes)}, {formatCount(snapshot.fileCount, 'file')}
                </span>
              ),
            },
            {
              key: 'taken',
              header: 'Taken',
              cell: (snapshot) => (
                <div className="safety-cell">
                  <RelativeTime value={snapshot.createdAt} />
                  {snapshot.createdBy ? (
                    <span className="safety-cell__detail">by {snapshot.createdBy}</span>
                  ) : null}
                </div>
              ),
            },
            {
              key: 'archive',
              header: <VisuallyHidden>Archive</VisuallyHidden>,
              align: 'end',
              cell: (snapshot) => (
                <Button asChild size="sm" variant="ghost" icon={DownloadSimple}>
                  <a
                    href={snapshotArchiveUrl(projectId, snapshot.id)}
                    download
                    aria-label={`Download snapshot ${snapshot.name}`}
                  >
                    Download
                  </a>
                </Button>
              ),
            },
          ]}
          {...(canWrite
            ? {
                rowActions: (snapshot: SnapshotSummary) => [
                  {
                    label: 'Restore project to',
                    icon: ArrowClockwise,
                    onSelect: () => setRestoring(snapshot),
                  },
                  {
                    label: 'Restore one file from',
                    icon: FileText,
                    onSelect: () => setPickingFile(snapshot),
                  },
                  {
                    label: 'Delete',
                    icon: Trash,
                    tone: 'danger' as const,
                    onSelect: () => setDeleting(snapshot),
                  },
                ],
              }
            : {})}
        />
      ) : null}

      <StopFirstDialog
        projectId={projectId}
        open={restoring !== undefined}
        onOpenChange={(open) => {
          if (!open) setRestoring(undefined);
        }}
        tone="danger"
        title={restoring ? `Restore project to snapshot ${restoring.name}?` : ''}
        body={
          <p>
            Every file becomes what this snapshot holds. What is there now is kept as a snapshot
            first, so this can be undone.
          </p>
        }
        confirmLabel="Restore project"
        onConfirm={async () => {
          if (!restoring) return;
          const result = await restoreSnapshot(projectId, restoring.id);
          setRestored(result);
          toast({ tone: 'success', title: `Restored to snapshot ${restoring.name}` });
          list.reload();
        }}
      />

      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        tone="danger"
        title={deleting ? `Delete snapshot ${deleting.name}?` : ''}
        body="The archive is deleted for good. Commits and other snapshots are not affected."
        confirmLabel="Delete snapshot"
        onConfirm={async () => {
          if (!deleting) return;
          await deleteSnapshot(projectId, deleting.id);
          toast({ tone: 'success', title: `Deleted snapshot ${deleting.name}` });
          list.reload();
        }}
      />

      {pickingFile ? (
        <RestoreFileDialog
          projectId={projectId}
          open
          onOpenChange={(open) => {
            if (!open) setPickingFile(undefined);
          }}
          source={`snapshot ${pickingFile.name}`}
          restore={(path) => restoreFileFromSnapshot(projectId, pickingFile.id, path)}
          onRestored={(file) => {
            setRestoredFile(file);
            toast({ tone: 'success', title: `Restored ${file.path}` });
          }}
        />
      ) : null}
    </section>
  );
}
