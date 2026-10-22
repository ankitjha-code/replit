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

export async function leaveProject(projectId: string): Promise<void> {
  await apiRequest<void>(`${membersBase(projectId)}/me`, { method: 'DELETE' });
}
