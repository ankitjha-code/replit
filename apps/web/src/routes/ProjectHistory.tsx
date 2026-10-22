import { useState, type FormEvent } from 'react';
import type { GitChange, GitCommit, RestoreResult } from '@platform/shared';
import { Field } from '../components/Field.js';
import { fieldErrorsFrom } from '../lib/form-errors.js';
import { describeCounts, formatCount } from '../lib/format.js';
import {
  commitProject,
  fetchCommit,
  fetchGitState,
  restoreCommit,
  restoreFileFromCommit,
} from '../lib/git-api.js';
import { useAction } from '../lib/use-action.js';
import { useResource } from '../lib/use-resource.js';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  ListRow,
  RelativeTime,
  RowActions,
  SectionHeader,
  Skeleton,
  VisuallyHidden,
  toast,
  type Tone,
} from '../ui/index.js';
import { ArrowClockwise, GitCommit as GitCommitIcon, ListDashes } from '../ui/icons.js';
import { RestoredFileCallout, restoreOneFile, type RestoredFile } from './safety/restore-file.js';
import { StopFirstDialog } from './settings/StopFirstDialog.js';
import './safety/safety.css';

const PAGE = 20;
const PENDING_SHOWN = 8;

const CHANGE_WORDS: Record<GitChange['kind'], { word: string; tone: Tone }> = {
  added: { word: 'Added', tone: 'ok' },
  modified: { word: 'Modified', tone: 'info' },
  removed: { word: 'Removed', tone: 'danger' },
};

type CommitDetail =
  | { status: 'loading' }
  | { status: 'ready'; changes: GitChange[] }
  | { status: 'error'; message: string };

export const shortOid = (oid: string): string => oid.slice(0, 7);

export function ProjectHistory({
  projectId,
  canWrite,
  reloadNonce = 0,
}: {
  projectId: string;
  canWrite: boolean;
  reloadNonce?: number;
}): React.JSX.Element {
  const git = useResource((signal) => fetchGitState(projectId, signal), [projectId, reloadNonce]);
  const [message, setMessage] = useState('');
  const [messageError, setMessageError] = useState<string | undefined>();
  const [shown, setShown] = useState(PAGE);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [details, setDetails] = useState<Record<string, CommitDetail>>({});
  const [restoring, setRestoring] = useState<GitCommit | undefined>();
  const [restored, setRestored] = useState<RestoreResult | undefined>();
  const [restoredFile, setRestoredFile] = useState<RestoredFile | undefined>();
  const [fileTarget, setFileTarget] = useState<string | undefined>();

  const commit = useAction(() => commitProject(projectId, message.trim()));
  const restoreFile = useAction((oid: string, path: string) =>
    restoreOneFile(projectId, `commit ${shortOid(oid)}`, () =>
      restoreFileFromCommit(projectId, oid, path),
    ),
  );

  const state = git.data;
  const commits = state?.commits ?? [];
  const pending = state?.pendingChanges ?? [];
  const unavailable = state?.unavailableReason ?? null;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (message.trim() === '') {
      setMessageError('Say what changed');
      document.getElementById('commit-message')?.focus();
      return;
    }
    setMessageError(undefined);
    const outcome = await commit.run();
    if (outcome.ok) {
      setMessage('');
      toast({ tone: 'success', title: 'Committed', description: message.trim() });
      git.reload();
    }
  };

  const loadDetail = async (oid: string): Promise<void> => {
    setDetails((held) => ({ ...held, [oid]: { status: 'loading' } }));
    try {
      const detail = await fetchCommit(projectId, oid);
      setDetails((held) => ({ ...held, [oid]: { status: 'ready', changes: detail.changes } }));
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : 'The changes could not be loaded.';
      setDetails((held) => ({ ...held, [oid]: { status: 'error', message: text } }));
    }
  };

  const toggle = (oid: string): void => {
    if (expanded.includes(oid)) {
      setExpanded(expanded.filter((held) => held !== oid));
      return;
    }
    setExpanded([...expanded, oid]);
    if (!details[oid]) void loadDetail(oid);
  };

  const restoreOne = async (oid: string, path: string): Promise<void> => {
    setFileTarget(`${oid}:${path}`);
    const outcome = await restoreFile.run(oid, path);
    setFileTarget(undefined);
    if (outcome.ok) {
      setRestoredFile(outcome.value);
      toast({ tone: 'success', title: `Restored ${path}` });
    } else {
      toast({
        tone: 'danger',
        title: 'The file could not be restored',
        description: outcome.error.message,
      });
    }
  };

  const commitFailure = commit.error ? fieldErrorsFrom(commit.error) : undefined;
  const commitFieldError = messageError ?? commitFailure?.fields.message;
  const commitGeneralError = commitFieldError ? undefined : commitFailure?.message;

  const nothingToCommit =
    pending.length === 0
      ? commits.length === 0
        ? 'Nothing to commit yet: the project has no files.'
        : 'Nothing has changed since the last commit.'
      : undefined;
  const reasonId = 'commit-reason';

  return (
    <section className="safety-section" aria-label="Commits">
      <SectionHeader
        title="Commits"
        icon={GitCommitIcon}
        {...(commits.length > 0 ? { count: commits.length } : {})}
        description="Each commit records the files as they are now, so you can come back to them."
        help={
          <>
            <p>
              This is a real git repository kept beside the project. Restoring a commit puts the
              files back to what it held and leaves the branch where it is, so going back is
              recorded as the next commit rather than hidden.
            </p>
            <p>Branches and the remote are on the Git page.</p>
          </>
        }
      />

      {unavailable ? (
        <Callout tone="info" title="History is not available on this installation.">
          {unavailable}
        </Callout>
      ) : null}

      {git.status === 'error' && !state ? (
        <Callout
          tone="danger"
          title={git.error?.message ?? 'The history could not be loaded.'}
          action={
            <Button size="sm" onClick={git.reload}>
              Retry
            </Button>
          }
        />
      ) : null}

      {git.status === 'loading' && !state ? (
        <div className="safety-skeleton" aria-busy="true">
          {canWrite ? <Skeleton shape="block" height={72} /> : null}
          <Skeleton shape="row" />
          <Skeleton shape="row" />
          <Skeleton shape="row" />
        </div>
      ) : null}

      {state && !unavailable && canWrite ? (
        <form className="safety-form" onSubmit={(event) => void submit(event)} noValidate>
          <Field
            id="commit-message"
            label="Commit message"
            as="textarea"
            rows={2}
            value={message}
            placeholder="What changed"
            autoComplete="off"
            error={commitFieldError}
            onChange={(event) => {
              setMessage(event.target.value);
              if (messageError) setMessageError(undefined);
              if (commit.error) commit.reset();
            }}
          />
          <div className="safety-form__actions">
            <Button
              type="submit"
              variant="primary"
              loading={commit.busy}
              loadingLabel="Committing"
              disabled={Boolean(nothingToCommit)}
              aria-describedby={nothingToCommit ? reasonId : undefined}
            >
              Commit
            </Button>
            <p id={reasonId} className="safety-form__reason">
              {nothingToCommit ??
                `${formatCount(pending.length, 'file')} would go into this commit.`}
            </p>
          </div>
          {pending.length > 0 ? <ChangeList changes={pending} limit={PENDING_SHOWN} /> : null}
          {commitGeneralError ? <Callout tone="danger" title={commitGeneralError} /> : null}
        </form>
      ) : null}

      {restored ? (
        <Callout
          tone="ok"
          title={`Restored ${restored.label}: ${describeCounts(restored)}.`}
          onDismiss={() => setRestored(undefined)}
          action={
            restored.safetySnapshot ? (
              <Button size="sm" asChild>
                <a href="#history-snapshots">View snapshots</a>
              </Button>
            ) : undefined
          }
        >
          {restored.safetySnapshot
            ? `What was here before was kept as the snapshot "${restored.safetySnapshot.name}", so this can be undone.`
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

      {state && !unavailable ? (
        commits.length === 0 ? (
          <EmptyState
            icon={GitCommitIcon}
            title="No commits yet."
            body={
              canWrite
                ? 'Commit to record the current files so you can come back to them.'
                : 'Commits record the files at a moment so an editor can come back to them.'
            }
          />
        ) : (
          <>
            <ul className="safety-list">
              {commits.slice(0, shown).map((entry) => {
                const short = shortOid(entry.oid);
                const open = expanded.includes(entry.oid);
                const detail = details[entry.oid];
                return (
                  <ListRow
                    key={entry.oid}
                    title={firstLine(entry.message)}
                    description={
                      <>
                        <span className="safety-mono">{short}</span> by {entry.authorName}
                      </>
                    }
                    meta={<RelativeTime value={entry.timestamp * 1000} />}
                    actions={
                      <RowActions
                        objectName={`commit ${short}`}
                        inline={2}
                        items={[
                          {
                            label: open ? 'Hide changes in' : 'Show changes in',
                            icon: ListDashes,
                            onSelect: () => toggle(entry.oid),
                          },
                          ...(canWrite
                            ? [
                                {
                                  label: 'Restore project to',
                                  icon: ArrowClockwise,
                                  onSelect: () => setRestoring(entry),
                                },
                              ]
                            : []),
                        ]}
                      />
                    }
                    expanded={
                      open ? (
                        <CommitChanges
                          detail={detail}
                          onRetry={() => void loadDetail(entry.oid)}
                          restore={
                            canWrite
                              ? {
                                  busyPath: fileTarget?.startsWith(`${entry.oid}:`)
                                    ? fileTarget.slice(entry.oid.length + 1)
                                    : undefined,
                                  onRestore: (path) => void restoreOne(entry.oid, path),
                                }
                              : undefined
                          }
                        />
                      ) : undefined
                    }
                  />
                );
              })}
            </ul>
            {commits.length > shown ? (
              <div>
                <Button variant="ghost" onClick={() => setShown((count) => count + PAGE)}>
                  Show more ({Math.min(shown, commits.length)} of {commits.length})
                </Button>
              </div>
            ) : null}
          </>
        )
      ) : null}

      <StopFirstDialog
        projectId={projectId}
        open={restoring !== undefined}
        onOpenChange={(open) => {
          if (!open) setRestoring(undefined);
        }}
        tone="danger"
        title={restoring ? `Restore project to commit ${shortOid(restoring.oid)}?` : ''}
        body={
          <p>
            Every file becomes what this commit held. What is there now is kept as a snapshot first,
            so this can be undone.
          </p>
        }
        confirmLabel="Restore project"
        onConfirm={async () => {
          if (!restoring) return;
          const result = await restoreCommit(projectId, restoring.oid);
          setRestored(result);
          toast({ tone: 'success', title: `Restored to commit ${shortOid(restoring.oid)}` });
          git.reload();
        }}
      />
    </section>
  );
}

function firstLine(message: string): string {
  const line = message.split('\n', 1)[0]?.trim();
  return line && line.length > 0 ? line : '(no message)';
}

function ChangeList({
  changes,
  limit,
}: {
  changes: GitChange[];
  limit: number;
}): React.JSX.Element {
  const visible = changes.slice(0, limit);
  return (
    <>
      <ul className="safety-changes" aria-label="Files that would be committed">
        {visible.map((change) => (
          <li key={`${change.kind}:${change.path}`} className="safety-changes__item">
            <Badge tone={CHANGE_WORDS[change.kind].tone}>{CHANGE_WORDS[change.kind].word}</Badge>
            <span className="safety-mono safety-changes__path">{change.path}</span>
          </li>
        ))}
      </ul>
      {changes.length > limit ? (
        <p className="safety-changes__more">and {changes.length - limit} more</p>
      ) : null}
    </>
  );
}

function CommitChanges({
  detail,
  onRetry,
  restore,
}: {
  detail: CommitDetail | undefined;
  onRetry: () => void;
  restore: { busyPath: string | undefined; onRestore: (path: string) => void } | undefined;
}): React.JSX.Element {
  if (!detail || detail.status === 'loading') {
    return <Skeleton lines={3} />;
  }
  if (detail.status === 'error') {
    return (
      <Callout
        tone="danger"
        title="Could not load this commit's changes."
        action={
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        }
      >
        {detail.message}
      </Callout>
    );
  }
  if (detail.changes.length === 0) {
    return <p className="safety-muted">No file changes.</p>;
  }
  return (
    <ul className="safety-changes" aria-label="Files this commit changed">
      {detail.changes.map((change) => (
        <li key={`${change.kind}:${change.path}`} className="safety-changes__item">
          <Badge tone={CHANGE_WORDS[change.kind].tone}>{CHANGE_WORDS[change.kind].word}</Badge>
          <span className="safety-mono safety-changes__path">{change.path}</span>
          {restore ? (
            <Button
              size="sm"
              variant="ghost"
              icon={ArrowClockwise}
              loading={restore.busyPath === change.path}
              loadingLabel="Restoring the file"
              {...(change.kind === 'removed'
                ? {
                    disabledReason: 'This commit removed the file, so there is nothing to restore.',
                  }
                : {})}
              onClick={() => restore.onRestore(change.path)}
            >
              Restore this file
              <VisuallyHidden>: {change.path}</VisuallyHidden>
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
