import { jobListResponseSchema, type JobListResponse } from '@platform/shared';
import { apiRequest } from './api-client.js';

/**
 * Work the platform is doing for a project.
 *
 * Read-only apart from cancelling. There is no call that creates a job: jobs are
 * created by the requests people actually make, and an endpoint that queued
 * arbitrary work would be a way around the checks that decide whether it should
 * happen at all.
 */

const base = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}/jobs`;

export async function fetchJobs(projectId: string, signal?: AbortSignal): Promise<JobListResponse> {
  const payload = await apiRequest<unknown>(base(projectId), signal ? { signal } : {});
  return jobListResponseSchema.parse(payload);
}

export async function cancelJob(projectId: string, jobId: string): Promise<void> {
  await apiRequest<unknown>(`${base(projectId)}/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
    body: {},
  });
}
