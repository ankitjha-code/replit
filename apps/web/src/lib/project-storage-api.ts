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

/**
 * Project assets and project secrets.
 *
 * Together because they are the two things a project keeps that are not its
 * source, and they appear side by side in settings. They behave oppositely in
 * the one way that matters: an asset can be read back and a secret never can.
 */

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

/**
 * Uploads one file as the raw request body.
 *
 * Sent with `fetch` rather than through the shared client, because the body is
 * bytes rather than JSON and the client's one job is to serialise JSON.
 */
export async function uploadAsset(projectId: string, file: File): Promise<AssetSummary> {
  let response: Response;

  try {
    response = await fetch(assetsBase(projectId), {
      method: 'POST',
      credentials: 'include',
      headers: {
        [ASSET_NAME_HEADER]: file.name,
        'content-type': file.type || 'application/octet-stream',
      },
      body: file,
    });
  } catch {
    throw new ApiError('SERVICE_UNAVAILABLE', 'Could not reach the server', 0);
  }

  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const envelope = payload as
      { error?: { code?: string; message?: string; requestId?: string } } | undefined;
    throw new ApiError(
      (envelope?.error?.code ?? 'INTERNAL_ERROR') as never,
      envelope?.error?.message ?? 'The file could not be uploaded',
      response.status,
      envelope?.error?.requestId,
    );
  }

  return assetSummarySchema.parse((payload as { asset: unknown }).asset);
}

/** Where the browser fetches an asset from. Always served as a download. */
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

/**
 * A project's plain environment variables.
 *
 * The counterpart to the secret calls above, and their opposite in one
 * respect: these answers contain values. That is the point of the feature, and
 * the reason the two live in separate endpoints rather than one with a flag.
 */
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

/**
 * Sets many at once from the text of a `.env` file.
 *
 * Not all-or-nothing: the answer says which names were set and which lines were
 * refused and why, so a file with one bad line still sets the rest.
 */
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

/**
 * The database a project's application gets.
 *
 * Unlike the secret calls above, the answer contains a live credential. It is
 * the project's own credential for the project's own data, and the server only
 * gives it to an owner.
 */
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

/** Empties the database, keeping its name, owner and password. */
export async function resetProjectDatabase(projectId: string): Promise<DatabaseStateResponse> {
  const payload = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/database/reset`,
    { method: 'POST', body: {} },
  );
  return databaseStateResponseSchema.parse(payload);
}

/** Replaces the password, which is the only honest answer to one that leaked. */
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

/**
 * Project snapshots.
 *
 * The archive itself is not fetched here. It is served as a download, and a
 * link is the right way to ask for one: the browser then streams it to disk
 * rather than the page holding a whole project's source in memory.
 */
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

/**
 * Puts every file in the project back to what a snapshot holds.
 *
 * The result is returned rather than discarded because it names the snapshot
 * the platform took first. Without showing that, a restore would be an
 * irreversible-looking action that is in fact reversible, which is the wrong
 * way round to be wrong.
 */
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

/** Where the browser fetches the archive from. A link, not a request. */
export function snapshotArchiveUrl(projectId: string, snapshotId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/archive`;
}

/**
 * Copies of a project's database.
 *
 * There is no download. A dump is the entire contents of a database in one
 * file, and the server offers no route that hands one over — a backup exists to
 * be restored here, and restoring is the only thing that can be done with one.
 */
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

/**
 * Takes a copy now.
 *
 * Slow on purpose: this runs `pg_dump` in a container and waits for it, so the
 * caller should expect to be waiting for as long as the database is large. A
 * request that returned immediately would have to be polled, and the row it
 * would return says RUNNING either way.
 */
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

/** Puts a backup back, destroying whatever is in the database now. */
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

/**
 * Puts one file back from a snapshot. Works while the project runs, like a save,
 * and returns what the file held so the change can be undone at once.
 */
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
