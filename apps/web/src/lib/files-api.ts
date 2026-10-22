import {
  fileContentResponseSchema,
  fileTreeResponseSchema,
  searchResponseSchema,
  type FileContentResponse,
  type FileEntry,
  type FileTreeResponse,
  type SearchResponse,
} from '@platform/shared';
import { apiRequest } from './api-client.js';

const base = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}/files`;

export async function fetchFileTree(
  projectId: string,
  signal?: AbortSignal,
): Promise<FileTreeResponse> {
  const payload = await apiRequest<unknown>(base(projectId), signal ? { signal } : {});
  return fileTreeResponseSchema.parse(payload);
}

export async function fetchFileContent(
  projectId: string,
  path: string,
  signal?: AbortSignal,
): Promise<FileContentResponse> {
  const payload = await apiRequest<unknown>(
    `${base(projectId)}/content?path=${encodeURIComponent(path)}`,
    signal ? { signal } : {},
  );
  return fileContentResponseSchema.parse(payload);
}

export async function writeFile(
  projectId: string,
  input: { path: string; content: string; encoding?: 'utf8' | 'base64'; expectedVersion?: number },
): Promise<FileEntry> {
  const payload = await apiRequest<{ entry: FileEntry }>(`${base(projectId)}/content`, {
    method: 'PUT',
    body: input,
  });
  return payload.entry;
}

export async function createDirectory(projectId: string, path: string): Promise<FileEntry> {
  const payload = await apiRequest<{ entry: FileEntry }>(`${base(projectId)}/directory`, {
    method: 'POST',
    body: { path },
  });
  return payload.entry;
}

export async function movePath(projectId: string, from: string, to: string): Promise<FileEntry> {
  const payload = await apiRequest<{ entry: FileEntry }>(`${base(projectId)}/move`, {
    method: 'POST',
    body: { from, to },
  });
  return payload.entry;
}

export async function deletePath(projectId: string, path: string): Promise<void> {
  await apiRequest<void>(`${base(projectId)}?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  });
}

export async function searchFiles(
  projectId: string,
  query: string,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const payload = await apiRequest<unknown>(
    `${base(projectId)}/search?q=${encodeURIComponent(query)}`,
    signal ? { signal } : {},
  );
  return searchResponseSchema.parse(payload);
}

export function readAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsDataURL(blob);
  });
}

export async function uploadFile(projectId: string, path: string, blob: Blob): Promise<FileEntry> {
  const content = await readAsBase64(blob);
  return writeFile(projectId, { path, content, encoding: 'base64' });
}
