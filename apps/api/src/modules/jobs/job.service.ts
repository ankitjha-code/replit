import {
  JOB_PRIORITY,
  jobPayloadSchemas,
  type JobStatus,
  type JobSummary,
  type JobType,
} from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { ProjectEventPublisher } from '../../events/project-event-bus.js';
import type { JobQueue } from '../../jobs/queue.js';
import type { JobRecord, JobRepository } from './job.repository.js';

/**
 * Work the platform intends to do, written down.
 *
 * Two things here have always held a request open for as long as they took:
 * starting a runtime, where a first-time image pull can take minutes, and
 * building a deployment, where installing dependencies routinely does. Both were
 * recorded as known problems long before this. A browser tab is the wrong place
 * to keep that work, and a request that dies takes it with it.
 *
 * The order matters and is the same order every store-then-act path in this
 * codebase uses: **record first, nudge second**. A job that exists and has not
 * been announced is picked up on the next poll; a job that was announced and
 * never recorded is nothing at all.
 */

export interface JobServiceOptions {
  /** How many times a job is tried before it is left failed. */
  maxAttempts: number;
  /** How many of a project's jobs a listing returns. */
  listLimit: number;
}

export class JobService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly queue: JobQueue,
    private readonly options: JobServiceOptions,
    private readonly log: Logger,
  ) {}

  private events: ProjectEventPublisher | undefined;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }

  /**
   * Records work to be done, and says so.
   *
   * The payload is validated here rather than trusted, even though every caller
   * is inside this codebase. A payload is written by one version of the platform
   * and read by whichever version happens to pick it up, which may be the next
   * one: checking it on the way in is what makes checking it on the way out
   * meaningful rather than paranoid.
   */
  async enqueue<T extends JobType>(
    type: T,
    payload: unknown,
    options: { projectId: string | null },
  ): Promise<JobSummary> {
    const parsed = jobPayloadSchemas[type].safeParse(payload);

    if (!parsed.success) {
      // Not an AppError: a caller inside the platform got this wrong, and that
      // is a fault rather than a refusal to show somebody.
      throw new Error(`A ${type} job was enqueued with a payload that does not match its schema`);
    }

    const record = await this.jobs.enqueue({
      projectId: options.projectId,
      type,
      payload: parsed.data,
      maxAttempts: this.options.maxAttempts,
      priority: JOB_PRIORITY[type],
    });

    /*
     * Announced after it is recorded, and never awaited.
     *
     * A nudge is advice: losing one costs a poll interval, and waiting for one
     * would let an unreachable queue slow down or fail the request that created
     * the work.
     */
    this.queue.publish();

    this.log.info({ jobId: record.id, type, projectId: options.projectId }, 'job enqueued');
    if (options.projectId) this.events?.publish(options.projectId, { type: 'jobs.changed' });

    return toSummary(record);
  }

  async list(projectId: string): Promise<JobSummary[]> {
    const records = await this.jobs.listForProject(projectId, this.options.listLimit);
    return records.map(toSummary);
  }

  /**
   * Abandons work nobody has started.
   *
   * Refused once a worker holds it. Marking a running job cancelled would have
   * the platform describing work that is still happening as work that never did,
   * and there is no way to reach into a worker and stop it: the honest answer is
   * that it is too late.
   */
  async cancel(projectId: string, jobId: string): Promise<JobSummary> {
    const record = await this.jobs.findById(jobId);

    if (!record || record.projectId !== projectId) {
      throw new AppError('NOT_FOUND', 'There is no job with that identifier');
    }

    const cancelled = await this.jobs.cancel(jobId);

    if (!cancelled) {
      throw new AppError(
        'PRECONDITION_FAILED',
        record.status === 'RUNNING'
          ? 'This work has already started, so it cannot be cancelled.'
          : 'This work has already finished.',
      );
    }

    this.log.info({ jobId, projectId }, 'job cancelled');
    this.events?.publish(projectId, { type: 'jobs.changed' });

    const after = await this.jobs.findById(jobId);
    return toSummary(after ?? { ...record, status: 'CANCELLED' as JobStatus });
  }
}

export function toSummary(record: JobRecord): JobSummary {
  return {
    id: record.id,
    type: record.type,
    status: record.status,
    attempts: record.attempts,
    maxAttempts: record.maxAttempts,
    lastError: record.lastError,
    scheduledAt: record.scheduledAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    finishedAt: record.finishedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}
