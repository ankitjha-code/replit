import {
  deploymentLogResponseSchema,
  deploymentResponseSchema,
  deploymentStateResponseSchema,
  type DeploymentConfig,
  type DeploymentLogResponse,
  type DeploymentStateResponse,
  type DeploymentSummary,
  type RollbackRequest,
} from '@platform/shared';
import { apiRequest } from './api-client.js';

const base = (projectId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/deployments`;

export async function fetchDeployments(
  projectId: string,
  signal?: AbortSignal,
): Promise<DeploymentStateResponse> {
  const payload = await apiRequest<unknown>(base(projectId), signal ? { signal } : {});
  return deploymentStateResponseSchema.parse(payload);
}

export async function setDeploymentConfig(
  projectId: string,
  config: DeploymentConfig,
): Promise<DeploymentStateResponse> {
  const payload = await apiRequest<unknown>(`${base(projectId)}/config`, {
    method: 'PUT',
    body: config,
  });
  return deploymentStateResponseSchema.parse(payload);
}

export async function createDeployment(
  projectId: string,
  input: { note?: string },
): Promise<DeploymentSummary> {
  const payload = await apiRequest<unknown>(base(projectId), { method: 'POST', body: input });
  return deploymentResponseSchema.parse(payload).deployment;
}

export async function stopDeployment(
  projectId: string,
  deploymentId: string,
): Promise<DeploymentSummary> {
  const payload = await apiRequest<unknown>(
    `${base(projectId)}/${encodeURIComponent(deploymentId)}/stop`,
    { method: 'POST', body: {} },
  );
  return deploymentResponseSchema.parse(payload).deployment;
}

export async function rollbackDeployment(
  projectId: string,
  deploymentId: string,
  input: RollbackRequest = {},
): Promise<DeploymentSummary> {
  const payload = await apiRequest<unknown>(
    `${base(projectId)}/${encodeURIComponent(deploymentId)}/rollback`,
    { method: 'POST', body: input },
  );
  return deploymentResponseSchema.parse(payload).deployment;
}

export async function fetchDeploymentLog(
  projectId: string,
  deploymentId: string,
  signal?: AbortSignal,
): Promise<DeploymentLogResponse> {
  const payload = await apiRequest<unknown>(
    `${base(projectId)}/${encodeURIComponent(deploymentId)}/log`,
    signal ? { signal } : {},
  );
  return deploymentLogResponseSchema.parse(payload);
}

export async function deleteDeployment(projectId: string, deploymentId: string): Promise<void> {
  await apiRequest<void>(`${base(projectId)}/${encodeURIComponent(deploymentId)}`, {
    method: 'DELETE',
  });
}
