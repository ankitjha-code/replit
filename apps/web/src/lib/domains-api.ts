import {
  customDomainListResponseSchema,
  customDomainResponseSchema,
  type CustomDomainListResponse,
  type CustomDomainSummary,
} from '@platform/shared';
import { apiRequest } from './api-client.js';

/**
 * The addresses a project is published on.
 *
 * Two kinds behind one set of calls: the label under the platform's own domain,
 * which is changed outright, and custom domains, which are added, verified and
 * removed. The difference is who owns the name, and it shows in the shape of
 * the calls: one is a setting, the others are a claim and a proof.
 */

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

/**
 * Checks whether a domain is really pointed here.
 *
 * Asked for explicitly rather than polled, so somebody who has just edited
 * their DNS can find out now instead of waiting for a sweep.
 */
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
