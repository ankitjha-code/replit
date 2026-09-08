import { useCallback, useEffect, useState } from 'react';
import { JOB_TYPE_LABELS, isJobSettled, type JobSummary } from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { cancelJob, fetchJobs } from '../lib/jobs-api.js';

/**
 * What the platform is doing for this project, and what it tried to do.
 *
 * Starting an environment and building a deployment used to happen inside the
 * request that asked for them, which meant a browser tab held open for a
 * dependency install and work lost if it closed. They are now recorded first and
 * done afterwards, and this is where that becomes visible rather than magic.
 *
 * The page is mostly about failure. A job that succeeds is a line somebody
 * scrolls past; a job on its third attempt, or one that failed for good with a
 * reason, is why this exists.
 */
export function ProjectJobs({
  projectId,
  canControl,
}: {
  projectId: string;
  canControl: boolean;
}): React.JSX.Element {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [workerRunning, setWorkerRunning] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const fetched = await fetchJobs(projectId, signal);
        if (signal?.aborted) return;
        setJobs(fetched.jobs);
        setWorkerRunning(fetched.workerRunning);
        setError(undefined);
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'The work list could not be loaded.');
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

  /*
   * Polled only while something is outstanding.
   *
   * A page of finished work does not change, so refreshing it would be a request
   * every few seconds for an answer that is already on screen. The moment
   * everything settles, the polling stops on its own.
   */
  const outstanding = jobs.some((job) => !isJobSettled(job.status));

  useEffect(() => {
    if (!outstanding) return;
    const timer = setInterval(() => void load(), 3_000);
    return () => clearInterval(timer);
  }, [outstanding, load]);

  const cancel = async (job: JobSummary): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await cancelJob(projectId, job.id);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'That work could not be cancelled.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="project-section" aria-labelledby="jobs-heading">
      <h2 id="jobs-heading">Background work</h2>
      <p className="project-section__hint">
        Starting an environment pulls an image and building a deployment installs dependencies. Both
        can take minutes, so the platform writes the work down and does it afterwards rather than
        holding your browser open for it.
      </p>

      {/* The one thing a queue must never do quietly: hold work nobody picks
          up. Said only when something is actually waiting. */}
      {!workerRunning && outstanding && (
        <p className="project-section__error" role="status">
          This control plane is not doing background work itself. If nothing else is running a
          worker, this will wait.
        </p>
      )}

      {error && (
        <p className="project-section__error" role="alert">
          {error}
        </p>
      )}

      {loading && <p className="project-section__note">Loading…</p>}

      {!loading && jobs.length === 0 && (
        <p className="project-section__note">Nothing has been queued for this project.</p>
      )}

      {jobs.length > 0 && (
        <ul className="project-section__list">
          {jobs.map((job) => (
            <li key={job.id} className="project-section__item">
              <span className="project-section__item-name">{JOB_TYPE_LABELS[job.type]}</span>
              <span className={`health health--${toneOf(job)}`}>{statusLabel(job)}</span>

              <span className="project-section__item-meta">
                {new Date(job.createdAt).toLocaleString()}
                {/* Only worth saying once it has happened more than once. */}
                {job.attempts > 1 ? ` · attempt ${job.attempts} of ${job.maxAttempts}` : ''}
              </span>

              {job.lastError && (
                <span className="project-section__item-value">{job.lastError}</span>
              )}

              {canControl && job.status === 'QUEUED' && (
                <button
                  type="button"
                  className="icon-button"
                  disabled={busy}
                  onClick={() => void cancel(job)}
                >
                  Cancel
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Where a job stands, in the words the page uses.
 *
 * "Waiting to try again" rather than "queued" once it has failed at least once,
 * because those are the same status and very different situations to be in.
 */
function statusLabel(job: JobSummary): string {
  switch (job.status) {
    case 'QUEUED':
      return job.attempts > 0 ? 'Failed, waiting to try again' : 'Waiting';
    case 'RUNNING':
      return 'Working';
    case 'SUCCEEDED':
      return 'Done';
    case 'FAILED':
      return 'Failed';
    case 'CANCELLED':
      return 'Cancelled';
  }
}

/** Which of the four health tones a job's status reads as. */
function toneOf(job: JobSummary): string {
  if (job.status === 'SUCCEEDED') return 'healthy';
  if (job.status === 'FAILED') return 'unhealthy';
  if (job.status === 'CANCELLED') return 'unknown';
  return 'unknown';
}
