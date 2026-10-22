import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  DEPLOYMENT_TARGETS,
  DEPLOYMENT_TARGET_LABELS,
  deploymentConfigProblem,
  isJobSettled,
  type DeploymentConfig,
  type DeploymentStateResponse,
  type DeploymentSummary,
  type DeploymentTarget,
} from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import {
  createDeployment,
  deleteDeployment,
  fetchDeploymentLog,
  fetchDeployments,
  rollbackDeployment,
  setDeploymentConfig,
  stopDeployment,
} from '../lib/deployments-api.js';
import { formatBytes, formatCount, formatDuration } from '../lib/format.js';
import { cancelJob, fetchJobs } from '../lib/jobs-api.js';
import { useAction } from '../lib/use-action.js';
import { useResource } from '../lib/use-resource.js';
import { ArrowClockwise, ArrowSquareOut, RocketLaunch, Scroll, Stop, Trash } from '../ui/icons.js';
import {
  Badge,
  Button,
  Callout,
  CodeBlock,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  FormRow,
  Input,
  ListRow,
  RelativeTime,
  RowActions,
  SectionHeader,
  Select,
  Skeleton,
  Spinner,
  StatusPill,
  toast,
} from '../ui/index.js';
import { BuildLogDialog } from './ship/BuildLogDialog.js';
import {
  canRollBackTo,
  deploymentObjectName,
  deploymentTitle,
  describeStatus,
  isBuilding,
  isSettling,
  shortId,
} from './ship/deployment-words.js';
import { settingsPath } from './settings/pages.js';
import './ship/ship.css';

const BLANK: DeploymentConfig = {
  target: 'STATIC',
  buildCommand: null,
  outputDirectory: null,
  startCommand: null,
};

const SETTLE_POLL_MS = 3_000;

const TAIL_LINES = 50;

const sameConfig = (a: DeploymentConfig | null | undefined, b: DeploymentConfig): boolean =>
  !!a &&
  a.target === b.target &&
  a.buildCommand === b.buildCommand &&
  a.outputDirectory === b.outputDirectory &&
  a.startCommand === b.startCommand;

type Pending =
  | { kind: 'stop'; deployment: DeploymentSummary }
  | { kind: 'rollback'; deployment: DeploymentSummary }
  | { kind: 'remove'; deployment: DeploymentSummary }
  | { kind: 'cancel'; deployment: DeploymentSummary };

export function ProjectDeployments({
  projectId,
  addressNonce,
  onAddressChanged,
}: {
  projectId: string;
  addressNonce: number;
  onAddressChanged: () => void;
}): React.JSX.Element {
  const state = useResource(
    (signal) => fetchDeployments(projectId, signal),
    [projectId, addressNonce],
    { poll: (data) => (data.deployments.some(isSettling) ? SETTLE_POLL_MS : null) },
  );
  const data = state.data;

  const [draft, setDraft] = useState<DeploymentConfig>();
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!data || dirty) return;
    setDraft(data.config ?? data.suggestion ?? BLANK);
  }, [data, dirty]);

  const [pending, setPending] = useState<Pending>();
  const [logOf, setLogOf] = useState<DeploymentSummary>();

  const update = (change: Partial<DeploymentConfig>): void => {
    setDirty(true);
    setDraft((current) => ({ ...(current ?? BLANK), ...change }));
  };

  const problem = draft ? deploymentConfigProblem(draft) : undefined;
  const configChanged = draft !== undefined && !sameConfig(data?.config, draft);

  const save = useAction(async () => {
    if (!draft) return;
    await setDeploymentConfig(projectId, draft);
    setDirty(false);
    state.reload();
  });

  const deploy = useAction(async () => {
    if (!draft) return;
    if (configChanged) await setDeploymentConfig(projectId, draft);
    const trimmed = note.trim();
    await createDeployment(projectId, trimmed ? { note: trimmed } : {});
    setDirty(false);
    setNote('');
    onAddressChanged();
  });

  const onSave = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (problem) return;
    const outcome = await save.run();
    if (outcome.ok) toast({ tone: 'success', title: 'Deployment settings saved' });
  };

  const onDeploy = async (): Promise<void> => {
    const outcome = await deploy.run();
    if (outcome.ok) {
      toast({
        tone: 'success',
        title: 'Deployment queued',
        description: 'The build shows below and in Activity while it runs.',
      });
    }
  };

  const deployReason = !data
    ? 'Loading deployments'
    : (data.unavailableReason ?? problem ?? undefined);
  const live = data?.deployments.find((deployment) => deployment.id === data.liveId);
  const building = data?.deployments.some(isBuilding) ?? false;
  const actionError = save.error ?? deploy.error;

  const afterChange = (title: string): void => {
    toast({ tone: 'success', title });
    state.reload();
  };

  return (
    <section className="ship-section">
      <SectionHeader
        title="Deployments"
        icon={RocketLaunch}
        description="A deployment runs a fixed copy of this project at a Live URL that stays up after you close the workspace."
        action={
          <Button
            variant="primary"
            icon={RocketLaunch}
            loading={deploy.busy}
            onClick={() => void onDeploy()}
            {...(deployReason ? { disabledReason: deployReason } : {})}
          >
            Deploy
          </Button>
        }
      />

      {data?.unavailableReason ? (
        <Callout tone="info" title="Deployments are not available on this installation.">
          {data.unavailableReason}
        </Callout>
      ) : null}

      {state.status === 'error' && !data ? (
        <Callout
          tone="danger"
          title={
            state.error instanceof ApiError
              ? state.error.message
              : 'Deployments could not be loaded.'
          }
          action={
            <Button size="sm" onClick={state.reload}>
              Retry
            </Button>
          }
        />
      ) : null}

      {live && data?.url ? <LiveCard url={data.url} deployment={live} /> : null}

      {!data && state.status === 'loading' ? (
        <div className="ship-list__skeleton" aria-busy="true">
          <Skeleton shape="row" />
          <Skeleton shape="row" />
          <Skeleton shape="row" />
        </div>
      ) : null}

      {draft ? (
        <form className="ship-form" onSubmit={(event) => void onSave(event)} noValidate>
          <FormRow
            label="Deployment type"
            htmlFor="deployment-target"
            hint={
              data && !data.config && data.suggestion
                ? 'Suggested from the files in this project.'
                : undefined
            }
          >
            <Select
              id="deployment-target"
              value={draft.target}
              options={DEPLOYMENT_TARGETS.map((value) => ({
                value,
                label: DEPLOYMENT_TARGET_LABELS[value],
              }))}
              onValueChange={(value) => {
                const next = value as DeploymentTarget;
                update(
                  next === 'STATIC'
                    ? { target: next, startCommand: null }
                    : { target: next, outputDirectory: null },
                );
              }}
            />
          </FormRow>
          <FormRow
            label="Build command"
            htmlFor="deployment-build"
            hint="Leave empty when there is nothing to build."
          >
            <Input
              id="deployment-build"
              mono
              value={draft.buildCommand ?? ''}
              onChange={(event) => update({ buildCommand: event.target.value || null })}
              placeholder="npm run build"
              autoComplete="off"
            />
          </FormRow>
          {draft.target === 'STATIC' ? (
            <FormRow
              label="Directory to serve"
              htmlFor="deployment-output"
              hint="Where the built files end up, inside the project."
            >
              <Input
                id="deployment-output"
                mono
                value={draft.outputDirectory ?? ''}
                onChange={(event) => update({ outputDirectory: event.target.value || null })}
                placeholder="dist"
                autoComplete="off"
              />
            </FormRow>
          ) : (
            <FormRow
              label="Start command"
              htmlFor="deployment-start"
              hint="How the deployed server starts."
            >
              <Input
                id="deployment-start"
                mono
                value={draft.startCommand ?? ''}
                onChange={(event) => update({ startCommand: event.target.value || null })}
                placeholder="npm start"
                autoComplete="off"
              />
            </FormRow>
          )}
          <FormRow
            label="Note (optional)"
            htmlFor="deployment-note"
            hint="Shown beside this deployment in the list."
          >
            <Input
              id="deployment-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What is in this one"
              maxLength={200}
              autoComplete="off"
            />
          </FormRow>

          {actionError ? (
            <Callout
              tone="danger"
              title={
                actionError instanceof ApiError
                  ? actionError.message
                  : 'That could not be done. Try again.'
              }
            />
          ) : null}

          <div className="ship-form__actions">
            <Button
              type="submit"
              variant="secondary"
              loading={save.busy}
              {...(problem
                ? { disabledReason: problem }
                : !configChanged
                  ? { disabledReason: 'Nothing has changed yet' }
                  : {})}
            >
              Save without deploying
            </Button>
          </div>
        </form>
      ) : null}

      {building ? (
        <Callout tone="info">
          You can leave this page; the build keeps going and also shows in{' '}
          <Link to={`${settingsPath(projectId, 'monitoring')}#monitoring-activity`}>Activity</Link>.
        </Callout>
      ) : null}

      {data ? (
        <DeploymentList
          projectId={projectId}
          state={data}
          onShowLog={setLogOf}
          onAct={setPending}
        />
      ) : null}

      <BuildLogDialog
        projectId={projectId}
        deployment={logOf}
        onOpenChange={(open) => {
          if (!open) setLogOf(undefined);
        }}
      />

      <ConfirmDialog
        open={pending?.kind === 'stop'}
        onOpenChange={(open) => {
          if (!open) setPending(undefined);
        }}
        title="Stop the live site?"
        body="The Live URL stops answering until another deployment is made live."
        confirmLabel={pending ? `Stop ${deploymentObjectName(pending.deployment)}` : 'Stop'}
        onConfirm={async () => {
          if (!pending) return;
          await stopDeployment(projectId, pending.deployment.id);
          afterChange('Deployment stopped');
        }}
      />

      <ConfirmDialog
        open={pending?.kind === 'remove'}
        onOpenChange={(open) => {
          if (!open) setPending(undefined);
        }}
        tone="danger"
        title={pending ? `Remove ${deploymentObjectName(pending.deployment)}?` : 'Remove?'}
        body="Its record, build output and stored files are removed. This cannot be undone."
        confirmLabel={pending ? `Remove ${deploymentObjectName(pending.deployment)}` : 'Remove'}
        onConfirm={async () => {
          if (!pending) return;
          await deleteDeployment(projectId, pending.deployment.id);
          afterChange('Deployment removed');
        }}
      />

      <RollbackDialog
        projectId={projectId}
        deployment={pending?.kind === 'rollback' ? pending.deployment : undefined}
        onOpenChange={(open) => {
          if (!open) setPending(undefined);
        }}
        onDone={() => afterChange('Rolling back')}
      />

      <ConfirmDialog
        open={pending?.kind === 'cancel'}
        onOpenChange={(open) => {
          if (!open) setPending(undefined);
        }}
        title="Cancel this build?"
        body="The deployment leaves the queue and nothing is published. The Live URL is not affected."
        confirmLabel="Cancel build"
        onConfirm={async () => {
          if (!pending) return;
          await cancelQueuedBuild(projectId, pending.deployment);
          afterChange('Build cancelled');
        }}
      />
    </section>
  );
}

async function cancelQueuedBuild(projectId: string, deployment: DeploymentSummary): Promise<void> {
  const { jobs } = await fetchJobs(projectId);
  const match = jobs.find((job) => job.deploymentId === deployment.id && !isJobSettled(job.status));
  if (!match) {
    throw new Error('No queued build was found for this deployment. It may have started already.');
  }
  await cancelJob(projectId, match.id);
}

function LiveCard({
  url,
  deployment,
}: {
  url: string;
  deployment: DeploymentSummary;
}): React.JSX.Element {
  return (
    <div className="ship-live" aria-live="polite">
      <div className="ship-live__row">
        <span className="ship-live__label">Live URL</span>
        <StatusPill tone="ok" dot>
          Live
        </StatusPill>
      </div>
      <div className="ship-live__row">
        <a className="ship-live__url" href={url} target="_blank" rel="noreferrer noopener">
          {url}
        </a>
        <CopyButton value={url} label="Copy Live URL" size="sm" />
        <Button asChild variant="ghost" size="sm" icon={ArrowSquareOut}>
          <a href={url} target="_blank" rel="noreferrer noopener">
            Open
          </a>
        </Button>
      </div>
      <p className="ship-live__meta">
        Deployed <RelativeTime value={deployment.startedAt ?? deployment.createdAt} />
        {deployment.requestedBy ? ` by ${deployment.requestedBy}` : ''}
        {deployment.note ? `: ${deployment.note}` : ''}
      </p>
    </div>
  );
}

function DeploymentList({
  projectId,
  state,
  onShowLog,
  onAct,
}: {
  projectId: string;
  state: DeploymentStateResponse;
  onShowLog: (deployment: DeploymentSummary) => void;
  onAct: (pending: Pending) => void;
}): React.JSX.Element {
  if (state.deployments.length === 0) {
    return (
      <EmptyState
        size="panel"
        icon={RocketLaunch}
        title="Nothing has been deployed yet."
        body="Deploy to give this project a Live URL that stays up after you close the workspace."
      />
    );
  }

  return (
    <>
      <ul className="ship-list" aria-label="Deployments">
        {state.deployments.map((deployment) => (
          <DeploymentRow
            key={deployment.id}
            projectId={projectId}
            deployment={deployment}
            live={deployment.id === state.liveId}
            onShowLog={() => onShowLog(deployment)}
            onAct={(kind) => onAct({ kind, deployment })}
          />
        ))}
      </ul>
      <p className="ship-list__count">
        {state.deployments.length} of {state.limit} deployments kept. The oldest are removed when
        the limit is reached.
      </p>
    </>
  );
}

function DeploymentRow({
  projectId,
  deployment,
  live,
  onShowLog,
  onAct,
}: {
  projectId: string;
  deployment: DeploymentSummary;
  live: boolean;
  onShowLog: () => void;
  onAct: (kind: Pending['kind']) => void;
}): React.JSX.Element {
  const status = describeStatus(deployment.status);
  const objectName = deploymentObjectName(deployment);
  const actions = [
    ...(deployment.hasLog
      ? [{ label: 'Build output for', icon: Scroll, onSelect: onShowLog }]
      : []),
    ...(live ? [{ label: 'Stop', icon: Stop, onSelect: () => onAct('stop') }] : []),
    ...(canRollBackTo(deployment)
      ? [{ label: 'Roll back to', icon: ArrowClockwise, onSelect: () => onAct('rollback') }]
      : []),
    ...(!live && !isSettling(deployment)
      ? [
          {
            label: 'Remove',
            icon: Trash,
            tone: 'danger' as const,
            onSelect: () => onAct('remove'),
          },
        ]
      : []),
  ];

  const size =
    deployment.fileCount === null
      ? undefined
      : `${formatCount(deployment.fileCount, 'file')}${
          deployment.artifactBytes === null ? '' : `, ${formatBytes(deployment.artifactBytes)}`
        }`;

  return (
    <ListRow
      title={
        <>
          {deploymentTitle(deployment)}{' '}
          <span className="ship-row__id">{shortId(deployment.id)}</span>
        </>
      }
      badge={
        <span className="ship-row__status" aria-live="polite">
          {status.busy && !live ? <Spinner size={12} aria-hidden="true" /> : null}
          <Badge tone={live ? 'ok' : status.tone} dot={live}>
            {live ? 'Live' : status.word}
          </Badge>
        </span>
      }
      description={
        <>
          <span className="ship-row__line">
            <RelativeTime value={deployment.createdAt} prefix="Deployed" />
            {deployment.requestedBy ? <span>by {deployment.requestedBy}</span> : null}
            {deployment.rolledBackFromId ? (
              <span>(rolled back from an earlier version)</span>
            ) : null}
          </span>
          {deployment.status === 'RUNNING' && deployment.releaseUrl ? (
            <span className="ship-row__line">
              <a
                className="ship-row__link"
                href={deployment.releaseUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                {deployment.releaseUrl}
              </a>
              <CopyButton
                value={deployment.releaseUrl}
                label={`Copy URL of ${objectName}`}
                size="sm"
              />
            </span>
          ) : null}
          {deployment.message ? (
            <span className={deployment.status === 'FAILED' ? 'ship-row__problem' : undefined}>
              {deployment.message}
            </span>
          ) : null}
        </>
      }
      meta={size}
      actions={actions.length > 0 ? <RowActions items={actions} objectName={objectName} /> : null}
      expanded={
        isBuilding(deployment) && !live ? (
          <BuildProgress
            projectId={projectId}
            deployment={deployment}
            onCancel={() => onAct('cancel')}
          />
        ) : undefined
      }
    />
  );
}

function BuildProgress({
  projectId,
  deployment,
  onCancel,
}: {
  projectId: string;
  deployment: DeploymentSummary;
  onCancel: () => void;
}): React.JSX.Element {
  const log = useResource(
    (signal) => fetchDeploymentLog(projectId, deployment.id, signal),
    [projectId, deployment.id],
    { poll: SETTLE_POLL_MS },
  );
  const elapsed = useElapsedSeconds(deployment.statusChangedAt);
  const status = describeStatus(deployment.status);

  const tail = log.data?.log ? lastLines(log.data.log, TAIL_LINES) : '';
  const queued = deployment.status === 'REQUESTED';

  return (
    <div className="ship-build" aria-label={`${status.word} ${deploymentObjectName(deployment)}`}>
      <div className="ship-build__head">
        <span className="ship-build__step" aria-live="polite">
          <Spinner size={16} aria-hidden="true" />
          <span>
            {status.word} for {formatDuration(elapsed)}
          </span>
        </span>
        <Button
          size="sm"
          variant="secondary"
          onClick={onCancel}
          {...(queued
            ? {}
            : {
                disabledReason:
                  'The build has already started on a worker and cannot be stopped from here.',
              })}
        >
          Cancel build
        </Button>
      </div>
      {tail ? (
        <CodeBlock code={tail} label="Build output so far" />
      ) : (
        <p className="ship-build__quiet">
          {queued
            ? 'Waiting for a worker to pick this up.'
            : 'The build is running. Its output appears here as soon as the platform reports it.'}
        </p>
      )}
    </div>
  );
}

function useElapsedSeconds(since: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - Date.parse(since)) / 1_000));
}

function lastLines(text: string, count: number): string {
  const lines = text.trimEnd().split('\n');
  return lines.slice(-count).join('\n');
}

function RollbackDialog({
  projectId,
  deployment,
  onOpenChange,
  onDone,
}: {
  projectId: string;
  deployment: DeploymentSummary | undefined;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}): React.JSX.Element {
  const [note, setNote] = useState('');
  const open = deployment !== undefined;
  useEffect(() => {
    if (!open) setNote('');
  }, [open]);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={deployment ? `Roll back to ${deploymentObjectName(deployment)}?` : 'Roll back?'}
      body={
        <div className="ship-form">
          <p>
            {deployment?.target === 'SERVER'
              ? 'A server is built again from the same code, so this takes as long as the original build. The current Live URL keeps answering until the new version is ready.'
              : 'The stored files of this version are published again. This takes a few seconds.'}
          </p>
          <FormRow label="Note (optional)" htmlFor="rollback-note">
            <Input
              id="rollback-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Why this version"
              maxLength={200}
              autoComplete="off"
            />
          </FormRow>
        </div>
      }
      confirmLabel={deployment ? `Roll back to ${deploymentObjectName(deployment)}` : 'Roll back'}
      onConfirm={async () => {
        if (!deployment) return;
        const trimmed = note.trim();
        await rollbackDeployment(projectId, deployment.id, trimmed ? { note: trimmed } : {});
        onDone();
      }}
    />
  );
}
