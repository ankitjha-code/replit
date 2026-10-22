import {
  healthCheckConfigSchema,
  monitoringResponseSchema,
  type HealthCheckConfig,
  type MonitoringResponse,
} from '@platform/shared';
import { apiRequest } from './api-client.js';

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
