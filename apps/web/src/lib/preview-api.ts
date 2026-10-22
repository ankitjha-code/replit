import {
  createPreviewShareResponseSchema,
  previewShareListResponseSchema,
  previewStateSchema,
  type CreatePreviewShareRequest,
  type PreviewShare,
  type PreviewState,
} from '@platform/shared';
import { apiRequest } from './api-client.js';

const base = (projectId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/preview`;

export async function fetchPreviewState(
  projectId: string,
  signal?: AbortSignal,
): Promise<PreviewState> {
  const payload = await apiRequest<unknown>(base(projectId), signal ? { signal } : {});
  return previewStateSchema.parse(payload);
}

export async function createPreviewGrant(projectId: string): Promise<string> {
  const payload = await apiRequest<{ url: string }>(`${base(projectId)}/grant`, {
    method: 'POST',
    body: {},
  });
  return payload.url;
}

export async function fetchPreviewShares(
  projectId: string,
  signal?: AbortSignal,
): Promise<PreviewShare[]> {
  const payload = await apiRequest<unknown>(`${base(projectId)}/shares`, signal ? { signal } : {});
  return previewShareListResponseSchema.parse(payload).shares;
}

export async function createPreviewShare(
  projectId: string,
  request: CreatePreviewShareRequest,
): Promise<{ share: PreviewShare; url: string }> {
  const payload = await apiRequest<unknown>(`${base(projectId)}/shares`, {
    method: 'POST',
    body: request,
  });
  return createPreviewShareResponseSchema.parse(payload);
}

export async function revokePreviewShare(projectId: string, shareId: string): Promise<void> {
  await apiRequest<unknown>(`${base(projectId)}/shares/${encodeURIComponent(shareId)}`, {
    method: 'DELETE',
  });
}
