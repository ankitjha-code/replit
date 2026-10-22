import {
  projectListResponseSchema,
  projectMemberResponseSchema,
  projectMembersResponseSchema,
  projectResponseSchema,
  type CreateProjectRequest,
  type ProjectMembersResponse,
  type ProjectMemberView,
  type ProjectRole,
  type ProjectSummary,
} from '@platform/shared';
import { apiRequest } from './api-client.js';

/**
 * Project calls.
 *
 * Responses are parsed against the shared schemas rather than trusted, so a
 * server change that breaks the contract surfaces here instead of as a
 * confusing render further down.
 */

export async function createProject(input: CreateProjectRequest): Promise<ProjectSummary> {
  const payload = await apiRequest<unknown>('/api/projects', { method: 'POST', body: input });
  return projectResponseSchema.parse(payload).project;
}

export async function listProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
  const payload = await apiRequest<unknown>('/api/projects', signal ? { signal } : {});
  return projectListResponseSchema.parse(payload).projects;
}

export async function getProject(id: string, signal?: AbortSignal): Promise<ProjectSummary> {
  const payload = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(id)}`,
    signal ? { signal } : {},
  );
  return projectResponseSchema.parse(payload).project;
}

/**
 * Renames a project, or changes its description. The slug never changes: it is
 * in every URL that has already been shared.
 */
export async function updateProject(
  id: string,
  input: { name?: string; description?: string | null },
): Promise<ProjectSummary> {
  const payload = await apiRequest<unknown>(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  });
  return projectResponseSchema.parse(payload).project;
}

export async function deleteProject(id: string): Promise<void> {
  await apiRequest<void>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Who else is in a project, and changing it.
 *
 * The listing carries what the caller may do, resolved by the server from their
 * own role. The client uses it to decide what to render and never to decide
 * what is allowed: every call below is checked again where it lands.
 */
const membersBase = (projectId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/members`;

export async function listProjectMembers(
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectMembersResponse> {
  const payload = await apiRequest<unknown>(membersBase(projectId), signal ? { signal } : {});
  return projectMembersResponseSchema.parse(payload);
}

export async function addProjectMember(
  projectId: string,
  input: { username: string; role: ProjectRole },
): Promise<ProjectMemberView> {
  const payload = await apiRequest<unknown>(membersBase(projectId), {
    method: 'POST',
    body: input,
  });
  return projectMemberResponseSchema.parse(payload).member;
}

export async function setProjectMemberRole(
  projectId: string,
  userId: string,
  role: ProjectRole,
): Promise<ProjectMemberView> {
  const payload = await apiRequest<unknown>(
    `${membersBase(projectId)}/${encodeURIComponent(userId)}`,
    { method: 'PATCH', body: { role } },
  );
  return projectMemberResponseSchema.parse(payload).member;
}

export async function removeProjectMember(projectId: string, userId: string): Promise<void> {
  await apiRequest<void>(`${membersBase(projectId)}/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
}

/**
 * Removes the caller from a project.
 *
 * Its own endpoint rather than the one above with your own identifier, so that
 * leaving can never be a mistyped way of removing somebody else.
 */
export async function leaveProject(projectId: string): Promise<void> {
  await apiRequest<void>(`${membersBase(projectId)}/me`, { method: 'DELETE' });
}
