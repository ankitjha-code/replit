import { z } from 'zod';

/**
 * Work the platform does that a request should not wait for.
 *
 * Two things in this platform have always held a request open for as long as
 * they took, and both were recorded as known problems long before this: starting
 * a runtime, where a first-time image pull can take minutes, and building a
 * deployment, where installing dependencies routinely does. A browser tab is the
 * wrong place to keep that work, and a request that dies takes it with it.
 *
 * So the work is written down first and done afterwards, by something that is
 * not the request.
 *
 * ## The record is the database, not the queue
 *
 * The single decision that shapes everything here. A job is a row: its status,
 * its attempts, what went wrong. The queue carries only a nudge saying "there is
 * something to do", and a worker with no nudge finds the same work by looking.
 *
 * The alternative — the queue holding the jobs — would mean two stores that can
 * disagree about what is outstanding, and one of them would be the one that
 * loses everything when it restarts. Every other part of this platform already
 * treats the database as the authority; a queue that quietly became a second one
 * would be the exception that made every failure hard to reason about.
 */

/**
 * What kind of work a job is.
 *
 * Deliberately a closed set. A job type is a handler somewhere in the control
 * plane, and a type nobody implements is a row that can never finish. Adding one
 * means adding both.
 */
export const JOB_TYPES = [
  /** Create and start a project's development container. */
  'RUNTIME_START',
  /** Build a deployment and publish it. */
  'DEPLOYMENT_BUILD',
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export const JOB_TYPE_LABELS: Readonly<Record<JobType, string>> = {
  RUNTIME_START: 'Starting the environment',
  DEPLOYMENT_BUILD: 'Building the deployment',
};

/**
 * Which work goes first when more is due than the workers can take.
 *
 * Starting an environment is somebody sitting at a spinner; a build is
 * somebody who pressed Deploy and went to do something else. Higher first. Kept
 * as data on each row rather than decided at claim time, so a later kind of job
 * can be given its own place without the claim changing.
 */
export const JOB_PRIORITY: Readonly<Record<JobType, number>> = {
  RUNTIME_START: 10,
  DEPLOYMENT_BUILD: 0,
};

/**
 * Where a job is in its life.
 *
 * `QUEUED` covers both "never started" and "failed and waiting to be tried
 * again": from outside they are the same thing, which is work the platform still
 * intends to do. The attempt count is what distinguishes them, and it is
 * reported separately rather than folded into a status.
 */
export const JOB_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** True once a job will not change again without somebody asking. */
export function isJobSettled(status: JobStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED';
}

/**
 * What each type of job needs in order to be done.
 *
 * Validated on the way out of the database as well as on the way in. A payload
 * is written by one version of the platform and may be read by the next, and a
 * handler that trusted a shape it did not check would act on whatever happened
 * to be in the column.
 */
export const runtimeStartPayloadSchema = z.object({
  runtimeId: z.string(),
  /** Who asked, recorded on the runtime's own transitions. */
  actorId: z.string(),
});

export const deploymentBuildPayloadSchema = z.object({
  deploymentId: z.string(),
  actorId: z.string(),
});

/*
 * The names are shouted rather than dotted, and that is not a style choice.
 *
 * A job type is a value in a database enum as well as a key here, and the two
 * must be the same string: a mapping between them would be a third place for
 * the set to drift, in the one table where a value the platform cannot decode
 * is a row that never finishes.
 */
export const jobPayloadSchemas = {
  RUNTIME_START: runtimeStartPayloadSchema,
  DEPLOYMENT_BUILD: deploymentBuildPayloadSchema,
} as const;

export type RuntimeStartPayload = z.infer<typeof runtimeStartPayloadSchema>;
export type DeploymentBuildPayload = z.infer<typeof deploymentBuildPayloadSchema>;

export const jobSummarySchema = z.object({
  id: z.string(),
  type: z.enum(JOB_TYPES),
  status: z.enum(JOB_STATUSES),

  /**
   * How many times it has been tried, and how many times it may be.
   *
   * Shown because a job on its third attempt is a different situation from one
   * that has never run, and a status alone cannot say which.
   */
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),

  /** What went wrong last time. Written to be shown; safe to display. */
  lastError: z.string().nullable(),

  /** When it is next due, which is later than now while it is backing off. */
  scheduledAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
});

export type JobSummary = z.infer<typeof jobSummarySchema>;

export const jobListResponseSchema = z.object({
  /** Newest first. */
  jobs: z.array(jobSummarySchema),
  /**
   * Whether anything is actually doing this work.
   *
   * False when the control plane was started with no worker and none is running
   * elsewhere. A queue that nothing reads is a list of promises, and a platform
   * that showed queued work without saying nobody is picking it up would be
   * making one it cannot keep.
   */
  workerRunning: z.boolean(),
});

export type JobListResponse = z.infer<typeof jobListResponseSchema>;
