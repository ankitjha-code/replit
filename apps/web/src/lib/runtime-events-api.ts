import { runtimeHistoryResponseSchema, type RuntimeEventSummary } from '@platform/shared';
import { apiRequest } from './api-client.js';

/**
 * What has happened to a project's environment, most recent first.
 *
 * Its own file rather than a line in `runtime-api.ts`, so the environment
 * popover and the getting-started checklist can both read it without either
 * waiting on the other's package.
 */
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
