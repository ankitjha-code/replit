import {
  customDomainListResponseSchema,
  customDomainResponseSchema,
  type CustomDomainListResponse,
  type CustomDomainSummary,
} from '@platform/shared';
import { apiRequest } from './api-client.js';

const base = (projectId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/domains`;

export async function fetchDomains(
  projectId: string,
  signal?: AbortSignal,
): Promise<CustomDomainListResponse> {
  const payload = await apiRequest<unknown>(base(projectId), signal ? { signal } : {});
  return customDomainListResponseSchema.parse(payload);
}

export async function setDeploymentSubdomain(projectId: string, subdomain: string): Promise<void> {
  await apiRequest<unknown>(`${base(projectId)}/subdomain`, {
    method: 'PUT',
    body: { subdomain },
  });
}

export async function addCustomDomain(
  projectId: string,
  hostname: string,
): Promise<CustomDomainSummary> {
  const payload = await apiRequest<unknown>(base(projectId), {
    method: 'POST',
    body: { hostname },
  });
  return customDomainResponseSchema.parse(payload).domain;
}

export async function verifyCustomDomain(
  projectId: string,
  domainId: string,
): Promise<CustomDomainSummary> {
  const payload = await apiRequest<unknown>(
    `${base(projectId)}/${encodeURIComponent(domainId)}/verify`,
    { method: 'POST', body: {} },
  );
  return customDomainResponseSchema.parse(payload).domain;
}

export async function removeCustomDomain(projectId: string, domainId: string): Promise<void> {
  await apiRequest<void>(`${base(projectId)}/${encodeURIComponent(domainId)}`, {
    method: 'DELETE',
  });
}
