import { useEffect, useState, type FormEvent } from 'react';
import type { GitBranch as Branch, GitRemote, GitStateResponse } from '@platform/shared';
import { Field } from '../components/Field.js';
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
import { useAction } from '../lib/use-action.js';
import { useResource } from '../lib/use-resource.js';
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  IconButton,
  KeyValue,
  RelativeTime,
  SectionHeader,
  Skeleton,
  Table,
  toast,
  type CalloutTone,
} from '../ui/index.js';
import { GitBranch as GitBranchIcon, PlugsConnected, Trash } from '../ui/icons.js';
import './safety/safety.css';

const OUTCOMES: Record<string, string> = {
  fastForward: 'Brought in by moving forward; no merge commit was needed.',
  merged: 'Merged, with a merge commit.',
  upToDate: 'Nothing to bring in: already up to date.',
  imported: "Imported the remote's history into this project.",
};

const shortOid = (oid: string): string => oid.slice(0, 7);

/** A long branch name may wrap after a slash, never in the middle of a word. */
function branchName(name: string): React.ReactNode {
  const parts = name.split('/');
  return parts.map((part, index) => (
    <span key={index}>
      {index > 0 ? '/' : null}
      {index > 0 ? <wbr /> : null}
      {part}
    </span>
  ));
}

interface Result {
  tone: CalloutTone;
  title: string;
  body?: string | undefined;
}

/**
 * Branches, and the one remote a project can push to and pull from.
 *
 * The project's files are the current branch. Switching and merging change
 * them, so both are refused while anything is uncommitted: the server says so,
 * and this section says it beside the button instead of offering one that
 * will fail.
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
  /** Called after anything that changed history, for a page that shows it too. */
  onChanged?: () => void;
}): React.JSX.Element {
  const git = useResource(
    (signal) => Promise.all([fetchGitState(projectId, signal), fetchRemote(projectId, signal)]),
    [projectId],
  );
  const [state, remote] = git.data ?? [undefined, null];
  const [result, setResult] = useState<Result | undefined>();
  const [creating, setCreating] = useState(false);
  const [merging, setMerging] = useState<Branch | undefined>();
  const [deleting, setDeleting] = useState<Branch | undefined>();
  const [switching, setSwitching] = useState<string | undefined>();

  const changed = (): void => {
    git.reload();
    onChanged?.();
  };

  const doSwitch = useAction(async (branch: Branch) => {
    setSwitching(branch.name);
    try {
      await switchBranch(projectId, branch.name);
    } finally {
      setSwitching(undefined);
    }
  });

  const unavailable = state?.unavailableReason ?? null;
  if (unavailable) {
    return (
      <section className="safety-section" aria-label="Git">
        <Callout tone="info" title="Git is not available on this installation.">
          {unavailable}
        </Callout>
      </section>
    );
  }

  const loading = git.status === 'loading' && !git.data;
  const failed = git.status === 'error' && !git.data;
  const current = state?.branch ?? 'main';
  const branches = state?.branches ?? [];
  const uncommitted = state?.hasUncommittedChanges ?? false;
  const initialized = state?.initialized ?? false;
  const uncommittedReason = uncommitted
    ? 'Commit your changes first. Nothing uncommitted is ever overwritten.'
    : undefined;

  return (
    <>
      <section className="safety-section" aria-label="Branches">
        <SectionHeader
          title="Branches"
          icon={GitBranchIcon}
          {...(branches.length > 1 ? { count: branches.length } : {})}
          description={
            state && initialized ? (
              <>
                On <strong>{current}</strong>
                {uncommitted
                  ? ', with uncommitted changes. Commit before switching or merging.'
                  : '. Switching or merging changes the files to match.'}
              </>
            ) : (
              'Branches let you try something without touching main.'
            )
          }
          action={
            canWrite && initialized && branches.length > 1 ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                New branch
              </Button>
            ) : undefined
          }
        />

        {failed ? (
          <Callout
            tone="danger"
            title={git.error?.message ?? 'Branches could not be loaded.'}
            action={
              <Button size="sm" onClick={git.reload}>
                Retry
              </Button>
            }
          />
        ) : null}

        {loading ? (
          <div className="safety-skeleton" aria-busy="true">
            <Skeleton shape="row" />
            <Skeleton shape="row" />
          </div>
        ) : null}

        {result ? (
          <Callout tone={result.tone} title={result.title} onDismiss={() => setResult(undefined)}>
            {result.body}
          </Callout>
        ) : null}

        {state && !initialized ? (
          <EmptyState
            icon={GitBranchIcon}
            title="One branch, main."
            body="Branches start from a commit. Make the first one on the History page, then branch from it."
          />
        ) : null}

        {state && initialized && branches.length <= 1 ? (
          <EmptyState
            icon={GitBranchIcon}
            title="One branch, main."
            body="Branches let you try something without touching main."
            action={
              canWrite ? (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  New branch
                </Button>
              ) : undefined
            }
          />
        ) : null}

        {state && initialized && branches.length > 1 ? (
          <Table
            caption="Branches"
            className="safety-branches"
            rows={branches}
            rowKey={(branch) => branch.name}
            empty={{ icon: GitBranchIcon, title: 'One branch, main.' }}
            columns={[
              {
                key: 'name',
                header: 'Branch',
                cell: (branch) => (
                  <span className="safety-cell__title">
                    <span className="safety-mono safety-branch-name">
                      {branchName(branch.name)}
                    </span>
                    {branch.current ? <Badge tone="accent">Current</Badge> : null}
                  </span>
                ),
              },
              {
                key: 'commit',
                header: 'Commit',
                mono: true,
                width: '7rem',
                cell: (branch) => shortOid(branch.headOid),
              },
              ...(canWrite
                ? [
                    {
                      key: 'actions',
                      header: <span className="visually-hidden">Actions</span>,
                      align: 'end' as const,
                      cell: (branch: Branch) =>
                        branch.current ? (
                          <span className="safety-muted">Checked out</span>
                        ) : (
                          <span className="safety-row-actions">
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={switching === branch.name}
                              loadingLabel={`Switching to ${branch.name}`}
                              {...(uncommittedReason ? { disabledReason: uncommittedReason } : {})}
                              onClick={() =>
                                void doSwitch.run(branch).then((outcome) => {
                                  if (outcome.ok) {
                                    toast({
                                      tone: 'success',
                                      title: `Switched to ${branch.name}`,
                                      description: "The files are now that branch's.",
                                    });
                                    setResult(undefined);
                                    changed();
                                  } else {
                                    setResult({ tone: 'danger', title: outcome.error.message });
                                  }
                                })
                              }
                            >
                              Switch to
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              {...(uncommittedReason ? { disabledReason: uncommittedReason } : {})}
                              onClick={() => setMerging(branch)}
                            >
                              Merge into {current}
                            </Button>
                            <IconButton
                              size="sm"
                              label={`Delete branch ${branch.name}`}
                              icon={Trash}
                              className="ui-row-actions__danger"
                              onClick={() => setDeleting(branch)}
                            />
                          </span>
                        ),
                    },
                  ]
                : []),
            ]}
          />
        ) : null}
      </section>

      <RemoteSection
        projectId={projectId}
        remote={remote}
        state={state}
        loading={loading}
        failed={failed}
        canWrite={canWrite}
        canManageRemote={canManageRemote}
        onChanged={changed}
        onReload={git.reload}
      />

      {state ? (
        <NewBranchDialog
          projectId={projectId}
          open={creating}
          onOpenChange={setCreating}
          branches={branches}
          current={current}
          onCreated={changed}
        />
      ) : null}

      <ConfirmDialog
        open={merging !== undefined}
        onOpenChange={(open) => {
          if (!open) setMerging(undefined);
        }}
        title={merging ? `Merge ${merging.name} into ${current}?` : ''}
        body={`The files become the result of the merge, and ${current} moves forward to it.`}
        confirmLabel="Merge"
        onConfirm={async () => {
          if (!merging) return;
          const { merge } = await mergeBranch(projectId, merging.name);
          setResult({
            tone: 'ok',
            title: `Merged ${merging.name} into ${current}.`,
            body: OUTCOMES[merge.outcome],
          });
          changed();
        }}
      />

      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        tone="danger"
        title={deleting ? `Delete branch ${deleting.name}?` : ''}
        body="Commits that are only on this branch are lost with it."
        confirmLabel="Delete branch"
        onConfirm={async () => {
          if (!deleting) return;
          await deleteBranch(projectId, deleting.name);
          toast({ tone: 'success', title: `Deleted branch ${deleting.name}` });
          changed();
        }}
      />
    </>
  );
}

/** Names a branch and picks the commit it starts from. */
function NewBranchDialog({
  projectId,
  open,
  onOpenChange,
  branches,
  current,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branches: Branch[];
  current: string;
  onCreated: () => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [from, setFrom] = useState(current);
  const [nameError, setNameError] = useState<string | undefined>();
  const create = useAction(() => {
    const base = branches.find((branch) => branch.name === from);
    // Branching from the current branch is the server's default; only another base is sent.
    const oid = base && base.name !== current ? base.headOid : undefined;
    return createBranch(projectId, name.trim(), oid);
  });

  useEffect(() => {
    if (open) {
      setName('');
      setFrom(current);
      setNameError(undefined);
      create.reset();
    }
  }, [open, current]);

  const failure = create.error ? fieldErrorsFrom(create.error) : undefined;
  const fieldError = nameError ?? failure?.fields.name;
  const generalError = fieldError ? undefined : failure?.message;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (name.trim() === '') {
      setNameError('Name the branch');
      return;
    }
    setNameError(undefined);
    const outcome = await create.run();
    if (outcome.ok) {
      toast({
        tone: 'success',
        title: `Created branch ${name.trim()}`,
        description: `From ${from}.`,
      });
      onCreated();
      onOpenChange(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New branch"
      description="A branch starts from a commit and moves on its own from there."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="new-branch-form"
            variant="primary"
            loading={create.busy}
            loadingLabel="Creating the branch"
          >
            Create branch
          </Button>
        </>
      }
    >
      <form
        id="new-branch-form"
        className="safety-dialog-form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <Field
          id="new-branch"
          label="Branch name"
          value={name}
          placeholder="feature/login"
          autoComplete="off"
          mono
          required
          error={fieldError}
          {...(fieldError
            ? {}
            : { hint: 'Letters, digits, dots, dashes, underscores and slashes.' })}
          onChange={(event) => {
            setName(event.target.value);
            if (nameError) setNameError(undefined);
            if (create.error) create.reset();
          }}
        />
        <Field
          id="new-branch-from"
          label="From"
          as="select"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
          options={branches.map((branch) => ({
            value: branch.name,
            label: `${branch.name} (${shortOid(branch.headOid)})`,
          }))}
        />
        {generalError ? <Callout tone="danger" title={generalError} /> : null}
      </form>
    </Dialog>
  );
}

/** The one remote: where it is, pushing and pulling, and the owner's form. */
function RemoteSection({
  projectId,
  remote,
  state,
  loading,
  failed,
  canWrite,
  canManageRemote,
  onChanged,
  onReload,
}: {
  projectId: string;
  remote: GitRemote | null;
  state: GitStateResponse | undefined;
  loading: boolean;
  failed: boolean;
  canWrite: boolean;
  canManageRemote: boolean;
  onChanged: () => void;
  onReload: () => void;
}): React.JSX.Element {
  const [result, setResult] = useState<Result | undefined>();
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [removing, setRemoving] = useState(false);
  const [forceOffered, setForceOffered] = useState(false);
  const [force, setForce] = useState(false);
  const [confirmingForce, setConfirmingForce] = useState(false);

  // The form shows what is stored; a change elsewhere (a reload) refreshes it.
  useEffect(() => {
    setUrl(remote?.url ?? '');
    setUsername(remote?.username ?? '');
  }, [remote?.url, remote?.username]);

  const current = state?.branch ?? 'main';
  const initialized = state?.initialized ?? false;
  const uncommitted = state?.hasUncommittedChanges ?? false;

  const save = useAction(() =>
    setRemote(projectId, {
      url: url.trim(),
      ...(username.trim() ? { username: username.trim() } : {}),
      // Blank keeps what is stored; the token is never shown to be edited.
      ...(token ? { token } : {}),
    }),
  );
  const push = useAction((forced: boolean) => pushToRemote(projectId, forced));
  const pull = useAction(() => pullFromRemote(projectId));

  const saveFailure = save.error ? fieldErrorsFrom(save.error) : undefined;
  const urlError = saveFailure?.fields.url;
  const saveGeneralError = urlError ? undefined : saveFailure?.message;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const outcome = await save.run();
    if (outcome.ok) {
      setToken('');
      toast({ tone: 'success', title: 'Remote saved' });
      onReload();
    }
  };

  const doPush = async (forced: boolean): Promise<void> => {
    const outcome = await push.run(forced);
    if (outcome.ok) {
      setForceOffered(false);
      setForce(false);
      setResult({ tone: 'ok', title: forced ? `Force pushed ${current}.` : `Pushed ${current}.` });
      onChanged();
      return;
    }
    // The remote is ahead. The way through is a pull, or knowingly replacing it.
    if (outcome.error instanceof ApiError && outcome.error.code === 'CONFLICT') {
      setForceOffered(true);
    }
    setResult({ tone: 'danger', title: 'Could not push.', body: outcome.error.message });
  };

  const doPull = async (): Promise<void> => {
    const outcome = await pull.run();
    if (outcome.ok) {
      setResult({
        tone: 'ok',
        title: 'Pulled.',
        body: OUTCOMES[outcome.value.outcome] ?? undefined,
      });
      onChanged();
    } else {
      setResult({ tone: 'danger', title: 'Could not pull.', body: outcome.error.message });
    }
  };

  const credentials = remote
    ? `${remote.username ? `Username ${remote.username}` : 'No username'}, ${
        remote.hasToken ? 'with a stored token' : 'no token stored'
      }`
    : '';

  return (
    <section className="safety-section" aria-label="Remote">
      <SectionHeader
        title="Remote"
        icon={PlugsConnected}
        description="Push and pull with GitHub, GitLab or any git host over https."
      />

      {loading ? (
        <div className="safety-skeleton" aria-busy="true">
          <Skeleton shape="row" />
          <Skeleton shape="row" />
        </div>
      ) : null}

      {failed ? (
        <Callout
          tone="danger"
          title="The remote could not be loaded."
          action={
            <Button size="sm" onClick={onReload}>
              Retry
            </Button>
          }
        />
      ) : null}

      {!loading && !failed && remote ? (
        <KeyValue
          items={[
            { term: 'Remote URL', value: remote.url, mono: true, copy: remote.url },
            { term: 'Credentials', value: credentials },
            {
              term: 'Last pushed',
              value: remote.lastPushedAt ? <RelativeTime value={remote.lastPushedAt} /> : 'Never',
            },
            {
              term: 'Last pulled',
              value: remote.lastPulledAt ? <RelativeTime value={remote.lastPulledAt} /> : 'Never',
            },
          ]}
        />
      ) : null}

      {!loading && !failed && remote && canWrite ? (
        <div className="safety-sync">
          <div className="safety-sync__actions">
            <Button
              loading={push.busy}
              loadingLabel="Pushing"
              {...(!initialized
                ? { disabledReason: 'Nothing to push yet. Make a commit first.' }
                : {})}
              onClick={() => {
                if (forceOffered && force) {
                  setConfirmingForce(true);
                  return;
                }
                void doPush(false);
              }}
            >
              Push {current}
            </Button>
            <Button
              loading={pull.busy}
              loadingLabel="Pulling"
              {...(uncommitted
                ? { disabledReason: 'Commit your changes before pulling.' }
                : !initialized
                  ? { disabledReason: 'Nothing to pull into yet. Make a commit first.' }
                  : {})}
              onClick={() => void doPull()}
            >
              Pull
            </Button>
          </div>
          {forceOffered ? (
            <Checkbox
              label="Force push"
              description={`Replace the remote ${current} with this one. Commits only on the remote are lost.`}
              checked={force}
              onCheckedChange={(checked) => setForce(checked)}
            />
          ) : null}
        </div>
      ) : null}

      {result ? (
        <Callout tone={result.tone} title={result.title} onDismiss={() => setResult(undefined)}>
          {result.body}
        </Callout>
      ) : null}

      {!loading && !failed && !remote && !canManageRemote ? (
        <EmptyState
          icon={PlugsConnected}
          title="No remote yet."
          body="The project owner can add one to push and pull with GitHub, GitLab or any git host."
        />
      ) : null}

      {!loading && !failed && canManageRemote ? (
        <form className="safety-form" onSubmit={(event) => void submit(event)} noValidate>
          <Field
            id="remote-url"
            label="Remote URL"
            type="url"
            value={url}
            placeholder="https://github.com/you/project.git"
            autoComplete="off"
            mono
            required
            error={urlError}
            {...(urlError || remote ? {} : { hint: 'The https address of the repository.' })}
            onChange={(event) => {
              setUrl(event.target.value);
              if (save.error) save.reset();
            }}
          />
          <Field
            id="remote-username"
            label="Username (optional)"
            value={username}
            autoComplete="off"
            onChange={(event) => setUsername(event.target.value)}
          />
          <Field
            id="remote-token"
            label={remote?.hasToken ? 'Replace token (blank keeps it)' : 'Access token (optional)'}
            type="password"
            value={token}
            autoComplete="new-password"
            hint="A personal access token the host issued. It is stored, never shown again."
            onChange={(event) => setToken(event.target.value)}
          />
          <div className="safety-form__actions">
            <Button
              type="submit"
              // Secondary: the page's one primary is the branch action above.
              variant="secondary"
              loading={save.busy}
              loadingLabel="Saving the remote"
            >
              Save remote
            </Button>
            {remote ? (
              <Button variant="ghost" onClick={() => setRemoving(true)}>
                Remove remote
              </Button>
            ) : null}
          </div>
          {saveGeneralError ? <Callout tone="danger" title={saveGeneralError} /> : null}
        </form>
      ) : null}

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        tone="danger"
        title="Remove the remote?"
        body="Pushing and pulling stop until another is added. The stored token is forgotten. The history here is untouched."
        confirmLabel="Remove remote"
        onConfirm={async () => {
          await removeRemote(projectId);
          setUrl('');
          setUsername('');
          setToken('');
          toast({ tone: 'success', title: 'Remote removed' });
          onReload();
        }}
      />

      <ConfirmDialog
        open={confirmingForce}
        onOpenChange={setConfirmingForce}
        tone="danger"
        title={`Force push ${current}?`}
        body="Commits on the remote that this branch does not have are lost. Anyone who pulled them has to reset."
        confirmLabel="Force push"
        onConfirm={async () => {
          const outcome = await push.run(true);
          if (!outcome.ok) throw outcome.error;
          setForceOffered(false);
          setForce(false);
          setResult({ tone: 'ok', title: `Force pushed ${current}.` });
          onChanged();
        }}
      />
    </section>
  );
}
