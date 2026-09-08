import {
  deploymentLogResponseSchema,
  deploymentResponseSchema,
  deploymentStateResponseSchema,
  type DeploymentConfig,
  type DeploymentLogResponse,
  type DeploymentStateResponse,
  type DeploymentSummary,
} from '@platform/shared';
import { apiRequest } from './api-client.js';

/**
 * Deployments: a project running somewhere that is not the workspace.
 *
 * Reading and changing the configuration return the same whole state, so the
 * page never has to work out what changed: it renders whatever came back.
 */

const base = (projectId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/deployments`;

export async function fetchDeployments(
  projectId: string,
  signal?: AbortSignal,
): Promise<DeploymentStateResponse> {
  const payload = await apiRequest<unknown>(base(projectId), signal ? { signal } : {});
  return deploymentStateResponseSchema.parse(payload);
}

/**
 * Records how a project is built and started.
 *
 * A PUT, because the fields depend on each other: a partial update could leave
 * a project half a static site and half a server.
 */
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

/**
 * Makes an earlier release live again.
 *
 * Answers 202 rather than 200 for a server release, because going back means
 * building it again: there is no image registry here, so what was kept is the
 * code and not the built container. A static release is published from its
 * stored output and is live by the time this resolves.
 */
export async function rollbackDeployment(
  projectId: string,
  deploymentId: string,
): Promise<DeploymentSummary> {
  const payload = await apiRequest<unknown>(
    `${base(projectId)}/${encodeURIComponent(deploymentId)}/rollback`,
    { method: 'POST', body: {} },
  );
  return deploymentResponseSchema.parse(payload).deployment;
}

/**
 * What a build printed.
 *
 * Fetched only when somebody asks. A log is large and most of the time nobody
 * looks at one, so carrying it in the listing would make every page load pay
 * for every build that ever ran.
 */
export async function fetchDeploymentLog(
  projectId: string,
  deploymentId: string,
): Promise<DeploymentLogResponse> {
  const payload = await apiRequest<unknown>(
    `${base(projectId)}/${encodeURIComponent(deploymentId)}/log`,
  );
  return deploymentLogResponseSchema.parse(payload);
}

export async function deleteDeployment(projectId: string, deploymentId: string): Promise<void> {
  await apiRequest<void>(`${base(projectId)}/${encodeURIComponent(deploymentId)}`, {
    method: 'DELETE',
  });
}
