import { runtimeHistoryResponseSchema, type RuntimeEventSummary } from '@platform/shared';
import { apiRequest } from './api-client.js';

export async function fetchRuntimeEvents(
  projectId: string,
  signal?: AbortSignal,
): Promise<RuntimeEventSummary[]> {
  const payload = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/runtime/events`,
    signal ? { signal } : {},
  );
  return runtimeHistoryResponseSchema.parse(payload).events;
}
