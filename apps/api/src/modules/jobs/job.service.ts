import {
  deploymentBuildPayloadSchema,
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

export interface JobServiceOptions {
  maxAttempts: number;
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

  async enqueue<T extends JobType>(
    type: T,
    payload: unknown,
    options: { projectId: string | null },
  ): Promise<JobSummary> {
    const parsed = jobPayloadSchemas[type].safeParse(payload);

    if (!parsed.success) {
      throw new Error(`A ${type} job was enqueued with a payload that does not match its schema`);
    }

    const record = await this.jobs.enqueue({
      projectId: options.projectId,
      type,
      payload: parsed.data,
      maxAttempts: this.options.maxAttempts,
      priority: JOB_PRIORITY[type],
    });

    this.queue.publish();

    this.log.info({ jobId: record.id, type, projectId: options.projectId }, 'job enqueued');
    if (options.projectId) this.events?.publish(options.projectId, { type: 'jobs.changed' });

    return toSummary(record);
  }

  async list(projectId: string): Promise<JobSummary[]> {
    const records = await this.jobs.listForProject(projectId, this.options.listLimit);
    return records.map(toSummary);
  }

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
    deploymentId: deploymentIdOf(record),
    scheduledAt: record.scheduledAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    finishedAt: record.finishedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}

function deploymentIdOf(record: JobRecord): string | null {
  if (record.type !== 'DEPLOYMENT_BUILD') return null;
  const parsed = deploymentBuildPayloadSchema.safeParse(record.payload);
  return parsed.success ? parsed.data.deploymentId : null;
}
