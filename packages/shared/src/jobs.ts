import { z } from 'zod';

export const JOB_TYPES = ['RUNTIME_START', 'DEPLOYMENT_BUILD'] as const;

export type JobType = (typeof JOB_TYPES)[number];

export const JOB_TYPE_LABELS: Readonly<Record<JobType, string>> = {
  RUNTIME_START: 'Starting the environment',
  DEPLOYMENT_BUILD: 'Building the deployment',
};

export const JOB_PRIORITY: Readonly<Record<JobType, number>> = {
  RUNTIME_START: 10,
  DEPLOYMENT_BUILD: 0,
};

export const JOB_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export function isJobSettled(status: JobStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED';
}

export const runtimeStartPayloadSchema = z.object({
  runtimeId: z.string(),
  actorId: z.string(),
});

export const deploymentBuildPayloadSchema = z.object({
  deploymentId: z.string(),
  actorId: z.string(),
});

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

  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),

  lastError: z.string().nullable(),

  deploymentId: z.string().nullable().default(null),

  scheduledAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
});

export type JobSummary = z.infer<typeof jobSummarySchema>;

export const jobListResponseSchema = z.object({
  jobs: z.array(jobSummarySchema),
  workerRunning: z.boolean(),
});

export type JobListResponse = z.infer<typeof jobListResponseSchema>;
