import { useState } from 'react';
import { Link } from 'react-router-dom';
import { isJobSettled, type DeploymentSummary, type JobSummary } from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { fetchDeployments } from '../lib/deployments-api.js';
import { cancelJob, fetchJobs } from '../lib/jobs-api.js';
import { useResource } from '../lib/use-resource.js';
import { Queue, XCircle } from '../ui/icons.js';
import {
  Badge,
  Callout,
  ConfirmDialog,
  RelativeTime,
  SectionHeader,
  Spinner,
  Table,
  toast,
  type Tone,
} from '../ui/index.js';
import { deploymentObjectName, deploymentTitle } from './ship/deployment-words.js';
import { settingsPath } from './settings/pages.js';
import './ship/ship.css';

/** How often the list is read again while something is still in progress. */
const POLL_MS = 3_000;

/** Rows shown before "Show more". */
const PAGE = 10;

/**
 * What the platform is doing for this project, and what it tried to do.
 *
 * Mostly about failure: a job that succeeds is a line somebody scrolls past;
 * a job on its third attempt, or one that failed for good with a reason, is
 * why this exists.
 */
export function ProjectJobs({
  projectId,
  canControl,
}: {
  projectId: string;
  canControl: boolean;
}): React.JSX.Element {
  const jobs = useResource((signal) => fetchJobs(projectId, signal), [projectId], {
    // A page of finished work does not change; the poll stops on its own.
    poll: (data) => (data.jobs.some((job) => !isJobSettled(job.status)) ? POLL_MS : null),
  });
  // Only to name the deployment a build belongs to; a failure here changes nothing.
  const deployments = useResource((signal) => fetchDeployments(projectId, signal), [projectId]);
  const [shown, setShown] = useState(PAGE);
  const [cancelling, setCancelling] = useState<JobSummary>();
  /** Which job's cancel is in flight, so its row says so. */
  const [inFlight, setInFlight] = useState<string>();

  const rows = jobs.data?.jobs.slice(0, shown) ?? [];
  const total = jobs.data?.jobs.length ?? 0;
  const workerMissing = jobs.data ? !jobs.data.workerRunning : false;

  return (
    <section className="ship-section">
      <SectionHeader
        title="Activity"
        icon={Queue}
        description="Environment starts and deployment builds appear here while they run, and stay with their outcome."
      />

      {workerMissing ? (
        <Callout tone="warn" title="No worker is running on this platform.">
          Queued work waits until one is started. An operator can check System status.
        </Callout>
      ) : null}

      <Table
        caption="Activity"
        density="regular"
        columns={[
          {
            key: 'work',
            header: 'Work',
            cell: (job) => (
              <WorkCell
                projectId={projectId}
                job={job}
                deployments={deployments.data?.deployments}
              />
            ),
          },
          {
            key: 'status',
            header: 'Status',
            cell: (job) => <StatusCell job={job} cancelling={inFlight === job.id} />,
          },
          {
            key: 'started',
            header: 'Started',
            cell: (job) =>
              job.startedAt ? (
                <RelativeTime value={job.startedAt} />
              ) : (
                <RelativeTime value={job.scheduledAt} prefix="Due" />
              ),
          },
          {
            key: 'finished',
            header: 'Finished',
            cell: (job) => (job.finishedAt ? <RelativeTime value={job.finishedAt} /> : ' '),
          },
        ]}
        rows={rows}
        rowKey={(job) => job.id}
        rowName={(job) => describeWork(job).toLowerCase()}
        {...(canControl
          ? {
              rowActions: (job: JobSummary) =>
                job.status === 'QUEUED'
                  ? [
                      {
                        label: 'Cancel',
                        icon: XCircle,
                        onSelect: () => setCancelling(job),
                        ...(inFlight === job.id
                          ? { disabledReason: 'Already being cancelled' }
                          : {}),
                      },
                    ]
                  : [],
            }
          : {})}
        loading={jobs.status === 'loading'}
        {...(jobs.status === 'error'
          ? {
              error:
                jobs.error instanceof ApiError
                  ? jobs.error.message
                  : 'Activity could not be loaded.',
              onRetry: jobs.reload,
            }
          : {})}
        empty={{
          icon: Queue,
          title: 'Nothing in progress.',
          body: 'Environment starts and deployment builds appear here while they run.',
        }}
        pagination={{
          count: rows.length,
          total,
          onMore: () => setShown((value) => value + PAGE),
        }}
      />

      <ConfirmDialog
        open={cancelling !== undefined}
        onOpenChange={(open) => {
          if (!open) setCancelling(undefined);
        }}
        title={cancelling ? `Cancel ${describeWork(cancelling).toLowerCase()}?` : 'Cancel?'}
        body="The work leaves the queue and is not done. Anything it would have produced is not made."
        confirmLabel={
          cancelling ? `Cancel ${describeWork(cancelling).toLowerCase()}` : 'Cancel work'
        }
        onConfirm={async () => {
          if (!cancelling) return;
          setInFlight(cancelling.id);
          try {
            await cancelJob(projectId, cancelling.id);
          } finally {
            setInFlight(undefined);
          }
          toast({ tone: 'success', title: 'Cancelled' });
          jobs.reload();
        }}
      />
    </section>
  );
}

/** The job in the words of the person who asked for it. */
function describeWork(job: JobSummary): string {
  switch (job.type) {
    case 'RUNTIME_START':
      return 'Starting environment';
    case 'DEPLOYMENT_BUILD':
      return 'Building deployment';
  }
}

function WorkCell({
  projectId,
  job,
  deployments,
}: {
  projectId: string;
  job: JobSummary;
  deployments: DeploymentSummary[] | undefined;
}): React.JSX.Element {
  const deploymentId = job.deploymentId;
  // Only for its note: the job names its deployment even when the list is
  // still loading, failed, or no longer holds a pruned one.
  const deployment = deploymentId ? deployments?.find((d) => d.id === deploymentId) : undefined;
  return (
    <span className="ship-activity__work">
      <span>
        {describeWork(job)}
        {deploymentId ? (
          <>
            {' '}
            <Link to={`${settingsPath(projectId, 'deploy')}#deploy-deployments`}>
              {deploymentObjectName({ id: deploymentId })}
            </Link>
            {deployment?.note ? ` (${deploymentTitle(deployment)})` : ''}
          </>
        ) : null}
      </span>
      {job.attempts > 1 ? (
        <span className="ship-activity__detail">
          Attempt {job.attempts} of {job.maxAttempts}
        </span>
      ) : null}
      {job.lastError ? <span className="ship-activity__detail">{job.lastError}</span> : null}
    </span>
  );
}

interface JobWords {
  word: string;
  tone: Tone;
  busy: boolean;
}

/**
 * "Waiting to try again" rather than "Queued" once it has failed at least
 * once: the same status and a very different situation to be in.
 */
function describeJob(job: JobSummary): JobWords {
  switch (job.status) {
    case 'QUEUED':
      return job.attempts > 0
        ? { word: 'Waiting to try again', tone: 'warn', busy: true }
        : { word: 'Queued', tone: 'info', busy: true };
    case 'RUNNING':
      return { word: 'In progress', tone: 'info', busy: true };
    case 'SUCCEEDED':
      return { word: 'Done', tone: 'ok', busy: false };
    case 'FAILED':
      return { word: 'Failed', tone: 'danger', busy: false };
    case 'CANCELLED':
      return { word: 'Cancelled', tone: 'neutral', busy: false };
  }
}

function StatusCell({
  job,
  cancelling,
}: {
  job: JobSummary;
  cancelling: boolean;
}): React.JSX.Element {
  const words = cancelling
    ? { word: 'Cancelling', tone: 'neutral' as Tone, busy: true }
    : describeJob(job);
  return (
    <span className="ship-row__status" aria-live="polite">
      {words.busy ? <Spinner size={12} aria-hidden="true" /> : null}
      <Badge tone={words.tone} dot={job.status === 'RUNNING' && !cancelling}>
        {words.word}
      </Badge>
    </span>
  );
}
