import {
  healthCheckConfigSchema,
  monitoringResponseSchema,
  type HealthCheckConfig,
  type MonitoringResponse,
} from '@platform/shared';
import { apiRequest } from './api-client.js';

/**
 * What a project's workloads are using, and whether they answer.
 *
 * Every reading is taken when it is asked for, so this is polled rather than
 * subscribed to. There is no stored history to page through: the trend lives in
 * the control plane's memory and the response says how long it covers.
 */

const base = (projectId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/monitoring`;

export async function fetchMonitoring(
  projectId: string,
  signal?: AbortSignal,
): Promise<MonitoringResponse> {
  const payload = await apiRequest<unknown>(base(projectId), signal ? { signal } : {});
  return monitoringResponseSchema.parse(payload);
}

export async function setHealthCheck(
  projectId: string,
  input: { path: string; timeoutMs?: number },
): Promise<HealthCheckConfig> {
  const payload = await apiRequest<unknown>(`${base(projectId)}/health-check`, {
    method: 'PUT',
    body: input,
  });
  return healthCheckConfigSchema.parse(payload);
}
