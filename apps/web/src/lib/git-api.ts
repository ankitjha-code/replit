import {
  gitCommitDetailResponseSchema,
  gitRemoteResponseSchema,
  gitStateResponseSchema,
  mergeResultSchema,
  restoreResponseSchema,
  type GitCommitDetailResponse,
  type GitRemote,
  type GitStateResponse,
  type MergeResult,
  type RestoreResult,
  type SetGitRemoteRequest,
} from '@platform/shared';
import { apiRequest } from './api-client.js';

/**
 * A project's history.
 *
 * Committing returns the whole state rather than just the new commit, so a
 * caller never has to guess what happened: it renders whatever came back.
 */

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

/**
 * Puts the project's files back to what a commit contained.
 *
 * Not a checkout: the branch does not move, and the next commit's parent is
 * still the current head. Going back is recorded as a step forward, which is a
 * truer history than one pretending the work in between never happened.
 */
export async function restoreCommit(projectId: string, oid: string): Promise<RestoreResult> {
  const payload = await apiRequest<unknown>(
    `${base(projectId)}/commits/${encodeURIComponent(oid)}/restore`,
    { method: 'POST' },
  );
  return restoreResponseSchema.parse(payload).restore;
}

export async function createBranch(projectId: string, name: string): Promise<GitStateResponse> {
  const payload = await apiRequest<unknown>(`${base(projectId)}/branches`, {
    method: 'POST',
    body: { name },
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

/** The project's files become the branch's. Refused while anything is uncommitted. */
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

/** An absent token keeps the stored one; an empty one removes it. */
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

export async function pushToRemote(projectId: string): Promise<GitStateResponse> {
  const payload = await apiRequest<unknown>(`${base(projectId)}/push`, {
    method: 'POST',
    body: {},
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
