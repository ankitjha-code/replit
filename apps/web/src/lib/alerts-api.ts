import { alertResponseSchema, type AlertResponse, type AlertSettings } from '@platform/shared';
import { apiRequest } from './api-client.js';

/** Deployment alerts for one project. */

const base = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}/alerts`;

export async function fetchAlerts(projectId: string, signal?: AbortSignal): Promise<AlertResponse> {
  const payload = await apiRequest<unknown>(base(projectId), signal ? { signal } : {});
  return alertResponseSchema.parse(payload);
}

export async function updateAlerts(
  projectId: string,
  settings: AlertSettings,
): Promise<AlertResponse> {
  const payload = await apiRequest<unknown>(base(projectId), { method: 'PUT', body: settings });
  return alertResponseSchema.parse(payload);
}
