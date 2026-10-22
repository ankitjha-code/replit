import {
  ASSET_NAME_HEADER,
  assetListResponseSchema,
  assetSummarySchema,
  secretListResponseSchema,
  secretSummarySchema,
  type AssetListResponse,
  type AssetSummary,
  type SecretListResponse,
  type SecretSummary,
  variableListResponseSchema,
  type VariableListResponse,
  importEnvironmentResponseSchema,
  type ImportEnvironmentRequest,
  type ImportEnvironmentResponse,
  databaseBackupListResponseSchema,
  databaseBackupSummarySchema,
  databaseStateResponseSchema,
  type DatabaseBackupSummary,
  type DatabaseStateResponse,
  restoreResponseSchema,
  restoreFileResponseSchema,
  type RestoreFileResponse,
  snapshotListResponseSchema,
  type RestoreResult,
  type SnapshotListResponse,
} from '@platform/shared';
import { apiRequest, ApiError } from './api-client.js';

const assetsBase = (projectId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/assets`;

const secretsBase = (projectId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/secrets`;

export async function fetchAssets(
  projectId: string,
  signal?: AbortSignal,
): Promise<AssetListResponse> {
  const payload = await apiRequest<unknown>(assetsBase(projectId), signal ? { signal } : {});
  return assetListResponseSchema.parse(payload);
}

export interface UploadAssetOptions {
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
}

export function uploadAsset(
  projectId: string,
  file: File,
  options: UploadAssetOptions = {},
): Promise<AssetSummary> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', assetsBase(projectId));
    request.withCredentials = true;
    request.responseType = 'text';
    request.setRequestHeader(ASSET_NAME_HEADER, file.name);
    request.setRequestHeader('content-type', file.type || 'application/octet-stream');

    const abort = (): void => request.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const settle = (): void => options.signal?.removeEventListener('abort', abort);

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded, event.total);
    });

    request.addEventListener('load', () => {
      settle();
      let payload: unknown;
      try {
        payload = JSON.parse(request.responseText) as unknown;
      } catch {
        payload = undefined;
      }

      if (request.status < 200 || request.status >= 300) {
        const envelope = payload as
          { error?: { code?: string; message?: string; requestId?: string } } | undefined;
        reject(
          new ApiError(
            (envelope?.error?.code ?? 'INTERNAL_ERROR') as never,
            envelope?.error?.message ?? 'The file could not be uploaded',
            request.status,
            envelope?.error?.requestId,
          ),
        );
        return;
      }

      try {
        resolve(assetSummarySchema.parse((payload as { asset: unknown }).asset));
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });

    request.addEventListener('error', () => {
      settle();
      reject(new ApiError('SERVICE_UNAVAILABLE', 'Could not reach the server', 0));
    });

    request.addEventListener('abort', () => {
      settle();
      reject(new DOMException('The upload was cancelled', 'AbortError'));
    });

    request.send(file);
  });
}

export function assetDownloadUrl(projectId: string, assetId: string): string {
  return `${assetsBase(projectId)}/${encodeURIComponent(assetId)}/content`;
}

export async function deleteAsset(projectId: string, assetId: string): Promise<void> {
  await apiRequest<void>(`${assetsBase(projectId)}/${encodeURIComponent(assetId)}`, {
    method: 'DELETE',
  });
}

export async function fetchSecrets(
  projectId: string,
  signal?: AbortSignal,
): Promise<SecretListResponse> {
  const payload = await apiRequest<unknown>(secretsBase(projectId), signal ? { signal } : {});
  return secretListResponseSchema.parse(payload);
}

export async function setSecret(
  projectId: string,
  input: { key: string; value: string },
): Promise<SecretSummary> {
  const payload = await apiRequest<{ secret: unknown }>(secretsBase(projectId), {
    method: 'PUT',
    body: input,
  });
  return secretSummarySchema.parse(payload.secret);
}

export async function deleteSecret(projectId: string, key: string): Promise<void> {
  await apiRequest<void>(`${secretsBase(projectId)}/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });
}

export async function fetchVariables(
  projectId: string,
  signal?: AbortSignal,
): Promise<VariableListResponse> {
  const payload = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/variables`,
    signal ? { signal } : {},
  );
  return variableListResponseSchema.parse(payload);
}

export async function setVariable(
  projectId: string,
  input: { key: string; value: string },
): Promise<void> {
  await apiRequest<unknown>(`/api/projects/${encodeURIComponent(projectId)}/variables`, {
    method: 'PUT',
    body: input,
  });
}

export async function importEnvironment(
  projectId: string,
  input: ImportEnvironmentRequest,
): Promise<ImportEnvironmentResponse> {
  const payload = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/variables/import`,
    { method: 'POST', body: input },
  );
  return importEnvironmentResponseSchema.parse(payload);
}

export async function deleteVariable(projectId: string, key: string): Promise<void> {
  await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/variables/${encodeURIComponent(key)}`,
    { method: 'DELETE' },
  );
}

export async function fetchProjectDatabase(
  projectId: string,
  signal?: AbortSignal,
): Promise<DatabaseStateResponse> {
  const payload = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/database`,
    signal ? { signal } : {},
  );
  return databaseStateResponseSchema.parse(payload);
}

export async function createProjectDatabase(projectId: string): Promise<DatabaseStateResponse> {
  const payload = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/database`,
    { method: 'POST', body: {} },
  );
  return databaseStateResponseSchema.parse(payload);
}

export async function resetProjectDatabase(projectId: string): Promise<DatabaseStateResponse> {
  const payload = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/database/reset`,
    { method: 'POST', body: {} },
  );
  return databaseStateResponseSchema.parse(payload);
}

export async function rotateProjectDatabasePassword(
  projectId: string,
): Promise<DatabaseStateResponse> {
  const payload = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/database/rotate`,
    { method: 'POST', body: {} },
  );
  return databaseStateResponseSchema.parse(payload);
}

export async function deleteProjectDatabase(projectId: string): Promise<DatabaseStateResponse> {
  const payload = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/database`,
    { method: 'DELETE' },
  );
  return databaseStateResponseSchema.parse(payload);
}

export async function fetchSnapshots(
  projectId: string,
  signal?: AbortSignal,
): Promise<SnapshotListResponse> {
  const payload = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/snapshots`,
    signal ? { signal } : {},
  );
  return snapshotListResponseSchema.parse(payload);
}

export async function createSnapshot(
  projectId: string,
  input: { name: string; description?: string },
): Promise<void> {
  await apiRequest<unknown>(`/api/projects/${encodeURIComponent(projectId)}/snapshots`, {
    method: 'POST',
    body: input,
  });
}

export async function deleteSnapshot(projectId: string, snapshotId: string): Promise<void> {
  await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}`,
    { method: 'DELETE' },
  );
}

export async function restoreSnapshot(
  projectId: string,
  snapshotId: string,
): Promise<RestoreResult> {
  const payload = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
    { method: 'POST' },
  );
  return restoreResponseSchema.parse(payload).restore;
}

export function snapshotArchiveUrl(projectId: string, snapshotId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/archive`;
}

export async function fetchDatabaseBackups(
  projectId: string,
  signal?: AbortSignal,
): Promise<DatabaseBackupSummary[]> {
  const payload = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/database/backups`,
    signal ? { signal } : {},
  );
  return databaseBackupListResponseSchema.parse(payload).backups;
}

export async function createDatabaseBackup(
  projectId: string,
  note: string | undefined,
): Promise<DatabaseBackupSummary> {
  const payload = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/database/backups`,
    { method: 'POST', body: note ? { note } : {} },
  );
  return databaseBackupSummarySchema.parse((payload as { backup: unknown }).backup);
}

export async function restoreDatabaseBackup(projectId: string, backupId: string): Promise<void> {
  await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/database/backups/${encodeURIComponent(backupId)}/restore`,
    { method: 'POST', body: { confirm: 'restore' } },
  );
}

export async function deleteDatabaseBackup(projectId: string, backupId: string): Promise<void> {
  await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/database/backups/${encodeURIComponent(backupId)}`,
    { method: 'DELETE' },
  );
}

export async function restoreFileFromSnapshot(
  projectId: string,
  snapshotId: string,
  path: string,
): Promise<RestoreFileResponse> {
  const payload = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/restore-file`,
    { method: 'POST', body: { path } },
  );
  return restoreFileResponseSchema.parse(payload);
}
