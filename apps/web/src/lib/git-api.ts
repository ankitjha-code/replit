import {
  gitCommitDetailResponseSchema,
  gitRemoteResponseSchema,
  gitStateResponseSchema,
  mergeResultSchema,
  restoreFileResponseSchema,
  restoreResponseSchema,
  type GitCommitDetailResponse,
  type GitRemote,
  type GitStateResponse,
  type MergeResult,
  type RestoreFileResponse,
  type RestoreResult,
  type SetGitRemoteRequest,
} from '@platform/shared';
import { apiRequest } from './api-client.js';

const base = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}/git`;

export async function fetchGitState(
  projectId: string,
  signal?: AbortSignal,
): Promise<GitStateResponse> {
  const payload = await apiRequest<unknown>(base(projectId), signal ? { signal } : {});
  return gitStateResponseSchema.parse(payload);
}

export async function commitProject(projectId: string, message: string): Promise<GitStateResponse> {
  const payload = await apiRequest<unknown>(`${base(projectId)}/commits`, {
    method: 'POST',
    body: { message },
  });
  return gitStateResponseSchema.parse(payload);
}

export async function fetchCommit(
  projectId: string,
  oid: string,
): Promise<GitCommitDetailResponse> {
  const payload = await apiRequest<unknown>(
    `${base(projectId)}/commits/${encodeURIComponent(oid)}`,
  );
  return gitCommitDetailResponseSchema.parse(payload);
}

export async function restoreCommit(projectId: string, oid: string): Promise<RestoreResult> {
  const payload = await apiRequest<unknown>(
    `${base(projectId)}/commits/${encodeURIComponent(oid)}/restore`,
    { method: 'POST' },
  );
  return restoreResponseSchema.parse(payload).restore;
}

export async function restoreFileFromCommit(
  projectId: string,
  oid: string,
  path: string,
): Promise<RestoreFileResponse> {
  const payload = await apiRequest<unknown>(
    `${base(projectId)}/commits/${encodeURIComponent(oid)}/restore-file`,
    { method: 'POST', body: { path } },
  );
  return restoreFileResponseSchema.parse(payload);
}

export async function createBranch(
  projectId: string,
  name: string,
  from?: string,
): Promise<GitStateResponse> {
  const payload = await apiRequest<unknown>(`${base(projectId)}/branches`, {
    method: 'POST',
    body: from ? { name, from } : { name },
  });
  return gitStateResponseSchema.parse(payload);
}

export async function deleteBranch(projectId: string, name: string): Promise<GitStateResponse> {
  const payload = await apiRequest<unknown>(
    `${base(projectId)}/branches/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  );
  return gitStateResponseSchema.parse(payload);
}

export async function switchBranch(projectId: string, name: string): Promise<GitStateResponse> {
  const payload = await apiRequest<unknown>(
    `${base(projectId)}/branches/${encodeURIComponent(name)}/switch`,
    { method: 'POST' },
  );
  return gitStateResponseSchema.parse(payload);
}

export async function mergeBranch(
  projectId: string,
  branch: string,
): Promise<{ merge: MergeResult; state: GitStateResponse }> {
  const payload = await apiRequest<{ merge: unknown; state: unknown }>(`${base(projectId)}/merge`, {
    method: 'POST',
    body: { branch },
  });
  return {
    merge: mergeResultSchema.parse(payload.merge),
    state: gitStateResponseSchema.parse(payload.state),
  };
}

export async function fetchRemote(
  projectId: string,
  signal?: AbortSignal,
): Promise<GitRemote | null> {
  const payload = await apiRequest<unknown>(`${base(projectId)}/remote`, signal ? { signal } : {});
  return gitRemoteResponseSchema.parse(payload).remote;
}

export async function setRemote(projectId: string, input: SetGitRemoteRequest): Promise<GitRemote> {
  const payload = await apiRequest<unknown>(`${base(projectId)}/remote`, {
    method: 'PUT',
    body: input,
  });
  return gitRemoteResponseSchema.parse(payload).remote!;
}

export async function removeRemote(projectId: string): Promise<void> {
  await apiRequest<unknown>(`${base(projectId)}/remote`, { method: 'DELETE' });
}

export async function pushToRemote(projectId: string, force = false): Promise<GitStateResponse> {
  const payload = await apiRequest<unknown>(`${base(projectId)}/push`, {
    method: 'POST',
    body: force ? { force: true } : {},
  });
  return gitStateResponseSchema.parse(payload);
}

export async function pullFromRemote(
  projectId: string,
): Promise<{ outcome: string; state: GitStateResponse }> {
  const payload = await apiRequest<{ outcome: string; state: unknown }>(`${base(projectId)}/pull`, {
    method: 'POST',
  });
  return { outcome: payload.outcome, state: gitStateResponseSchema.parse(payload.state) };
}
