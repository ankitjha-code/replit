import { jobListResponseSchema, type JobListResponse } from '@platform/shared';
import { apiRequest } from './api-client.js';

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
