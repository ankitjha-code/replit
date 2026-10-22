import { logResponseSchema, type LogQuery, type LogResponse } from '@platform/shared';
import { apiRequest } from './api-client.js';

export type LogFilter = Pick<LogQuery, 'source' | 'sourceId' | 'stream' | 'contains'>;

function logQueryParams(query: LogQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.source) params.set('source', query.source);
  if (query.sourceId) params.set('sourceId', query.sourceId);
  if (query.stream) params.set('stream', query.stream);
  if (query.before) params.set('before', query.before);
  if (query.after) params.set('after', query.after);
  if (query.contains) params.set('contains', query.contains);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  return params;
}

const base = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}/logs`;

export async function fetchLogs(
  projectId: string,
  query: LogQuery,
  signal?: AbortSignal,
): Promise<LogResponse> {
  const search = logQueryParams(query).toString();
  const payload = await apiRequest<unknown>(
    `${base(projectId)}${search ? `?${search}` : ''}`,
    signal ? { signal } : {},
  );

  return logResponseSchema.parse(payload);
}

export function logExportUrl(projectId: string, filter: LogFilter): string {
  const search = logQueryParams(filter).toString();
  return `${base(projectId)}/export${search ? `?${search}` : ''}`;
}
