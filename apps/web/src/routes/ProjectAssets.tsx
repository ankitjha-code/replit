import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssetSummary } from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import {
  assetDownloadUrl,
  deleteAsset,
  fetchAssets,
  uploadAsset,
} from '../lib/project-storage-api.js';

/**
 * A project's files that are not its source.
 *
 * Every one is served as a download rather than rendered, which is why there
 * is no preview here even for an image: these bytes came from a person, and a
 * file claiming to be a picture could be a page.
 */
export function ProjectAssets({
  projectId,
  canWrite,
}: {
  projectId: string;
  canWrite: boolean;
}): React.JSX.Element {
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [limitBytes, setLimitBytes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const listed = await fetchAssets(projectId, signal);
        if (signal?.aborted) return;
        setAssets(listed.assets);
        setTotalBytes(listed.totalBytes);
        setLimitBytes(listed.limitBytes);
        setError(undefined);
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'The files could not be loaded.');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const upload = async (file: File): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await uploadAsset(projectId, file);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The file could not be uploaded.');
    } finally {
      setBusy(false);
      // Cleared so the same file can be chosen again after a failure.
      if (input.current) input.current.value = '';
    }
  };

  const remove = async (asset: AssetSummary): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await deleteAsset(projectId, asset.id);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The file could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="project-section" aria-labelledby="assets-heading">
      <h2 id="assets-heading">Files</h2>
      <p className="project-section__hint">
        Images, sample data and anything else the project needs that is not source code. Source
        files live in the workspace.
      </p>

      {canWrite && (
        <div className="project-section__actions">
          <label className="button-quiet" htmlFor="asset-upload">
            {busy ? 'Uploading…' : 'Upload a file'}
          </label>
          <input
            id="asset-upload"
            ref={input}
            type="file"
            className="visually-hidden"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <span className="project-section__usage">
            {formatBytes(totalBytes)} of {formatBytes(limitBytes)} used
          </span>
        </div>
      )}

      {error && (
        <p className="project-section__error" role="alert">
          {error}
        </p>
      )}

      {loading && <p className="project-section__note">Loading files…</p>}

      {!loading && assets.length === 0 && <p className="project-section__note">No files yet.</p>}

      {assets.length > 0 && (
        <ul className="project-section__list">
          {assets.map((asset) => (
            <li key={asset.id} className="project-section__item">
              <span className="project-section__item-name">{asset.name}</span>
              <span className="project-section__item-meta">{formatBytes(asset.size)}</span>
              <a
                className="button-quiet"
                href={assetDownloadUrl(projectId, asset.id)}
                // The server sends it as an attachment regardless; this is only
                // so the browser does not navigate away from the page.
                download={asset.name}
              >
                Download
              </a>
              {canWrite && (
                <button
                  type="button"
                  className="icon-button"
                  disabled={busy}
                  onClick={() => void remove(asset)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} bytes`;
}
