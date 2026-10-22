import { useRef, useState, type DragEvent } from 'react';
import type { AssetSummary } from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { formatBytes } from '../lib/format.js';
import {
  assetDownloadUrl,
  deleteAsset,
  fetchAssets,
  uploadAsset,
} from '../lib/project-storage-api.js';
import { useResource } from '../lib/use-resource.js';
import { DownloadSimple, Package, Trash, UploadSimple } from '../ui/icons.js';
import {
  Button,
  Callout,
  ConfirmDialog,
  IconButton,
  Meter,
  Progress,
  RelativeTime,
  SectionHeader,
  Table,
  toast,
} from '../ui/index.js';
import { X } from '../ui/icons.js';
import './run/run.css';

interface Upload {
  id: number;
  name: string;
  size: number;
  sent: number;
  status: 'uploading' | 'failed';
  error?: string | undefined;
}

let nextUploadId = 1;

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
  const listed = useResource((signal) => fetchAssets(projectId, signal), [projectId]);
  const assets = listed.data?.assets ?? [];
  const totalBytes = listed.data?.totalBytes ?? 0;
  const limitBytes = listed.data?.limitBytes ?? 0;
  const full = listed.data !== undefined && totalBytes >= limitBytes;

  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [removing, setRemoving] = useState<AssetSummary | undefined>();
  const input = useRef<HTMLInputElement>(null);

  const patch = (id: number, change: Partial<Upload>): void =>
    setUploads((current) =>
      current.map((item) => (item.id === id ? { ...item, ...change } : item)),
    );

  /**
   * Uploads one after another. The server stores one file per request, so
   * parallel uploads would only race each other for the same quota and make
   * the progress bars lie about how much is left.
   */
  const upload = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    const queued = files.map((file) => ({
      id: nextUploadId++,
      file,
      row: { name: file.name, size: file.size, sent: 0, status: 'uploading' as const },
    }));
    setUploads((current) => [...current, ...queued.map((item) => ({ id: item.id, ...item.row }))]);

    let done = 0;
    for (const item of queued) {
      try {
        await uploadAsset(projectId, item.file, {
          onProgress: (sent) => patch(item.id, { sent }),
        });
        done += 1;
        setUploads((current) => current.filter((row) => row.id !== item.id));
      } catch (cause) {
        patch(item.id, {
          status: 'failed',
          error: cause instanceof ApiError ? cause.message : 'The file could not be uploaded.',
        });
      }
    }
    if (done > 0) {
      toast({
        tone: 'success',
        title: done === 1 ? `Uploaded ${queued[0]!.file.name}` : `Uploaded ${done} files`,
      });
      listed.reload();
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    if (!canWrite || full) return;
    void upload(Array.from(event.dataTransfer.files));
  };

  const uploadReason = full
    ? `This project has used all of its ${formatBytes(limitBytes)} of asset storage. Remove a file to upload another.`
    : undefined;

  return (
    <section className="run-section" aria-labelledby="assets-heading">
      <SectionHeader
        title={<span id="assets-heading">Assets</span>}
        icon={Package}
        description="Files the project keeps that are not source code: images, sample data, downloads."
        action={
          canWrite ? (
            <Button
              icon={UploadSimple}
              asChild
              {...(uploadReason ? { disabledReason: uploadReason } : {})}
            >
              <label htmlFor="asset-upload">Upload a file</label>
            </Button>
          ) : undefined
        }
      />

      {canWrite ? (
        <input
          id="asset-upload"
          ref={input}
          type="file"
          multiple
          className="visually-hidden"
          disabled={full}
          onChange={(event) => {
            void upload(Array.from(event.target.files ?? []));
            // Cleared so the same file can be chosen again after a failure.
            event.target.value = '';
          }}
        />
      ) : null}

      {/* Honest about reach: nothing copies these into the environment. */}
      <Callout tone="info">
        Assets are stored by the platform and downloaded from here. They are not copied into the
        environment; files your code reads belong in the workspace.
      </Callout>

      {full ? <Callout tone="warn" title={uploadReason} /> : null}

      <div className="assets-usage">
        <Meter
          value={listed.data ? totalBytes : null}
          max={limitBytes}
          label="Storage used"
          loading={listed.status === 'loading'}
          format={(used) => `${formatBytes(used)} of ${formatBytes(limitBytes)}`}
        />
      </div>

      {uploads.length > 0 ? (
        <ul className="assets-uploads" aria-label="Uploads in progress">
          {uploads.map((item) => (
            <li
              key={item.id}
              className={`assets-upload${item.status === 'failed' ? ' assets-upload--failed' : ''}`}
            >
              <span className="assets-upload__name">{item.name}</span>
              <span className="assets-upload__status">
                {item.status === 'failed'
                  ? item.error
                  : `${formatBytes(item.sent)} of ${formatBytes(item.size)}`}
              </span>
              {item.status === 'failed' ? (
                <IconButton
                  size="sm"
                  label={`Dismiss ${item.name}`}
                  icon={X}
                  className="assets-upload__dismiss"
                  onClick={() =>
                    setUploads((current) => current.filter((row) => row.id !== item.id))
                  }
                />
              ) : (
                <Progress
                  className="assets-upload__bar"
                  label={`Uploading ${item.name}`}
                  value={item.sent}
                  max={item.size || 1}
                />
              )}
            </li>
          ))}
        </ul>
      ) : null}

      <div
        className="assets-drop"
        data-active={dragging || undefined}
        onDragOver={(event) => {
          if (!canWrite || full) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <Table<AssetSummary>
          caption="Assets"
          density="dense"
          columns={[
            { key: 'name', header: 'Name', mono: true, cell: (asset) => asset.name },
            {
              key: 'size',
              header: 'Size',
              width: '96px',
              cell: (asset) => formatBytes(asset.size),
            },
            {
              key: 'uploaded',
              header: 'Uploaded',
              width: '120px',
              cell: (asset) => <RelativeTime value={asset.createdAt} />,
            },
          ]}
          rows={assets}
          rowKey={(asset) => asset.id}
          rowName={(asset) => asset.name}
          rowActions={(asset) => [
            {
              label: 'Download',
              icon: DownloadSimple,
              href: assetDownloadUrl(projectId, asset.id),
              // The server sends it as an attachment regardless; the download
              // attribute only keeps the browser on this page.
              download: asset.name,
            },
            ...(canWrite
              ? [
                  {
                    label: 'Remove',
                    icon: Trash,
                    tone: 'danger' as const,
                    onSelect: () => setRemoving(asset),
                  },
                ]
              : []),
          ]}
          loading={listed.status === 'loading'}
          {...(listed.status === 'error'
            ? {
                error:
                  listed.error instanceof ApiError
                    ? listed.error.message
                    : 'The assets could not be loaded.',
                onRetry: listed.reload,
              }
            : {})}
          empty={{
            icon: Package,
            title: 'No assets yet.',
            body: canWrite
              ? 'Drop files here, or use Upload a file. Images and data the project keeps outside its source live here.'
              : 'Images and data the project keeps outside its source live here.',
          }}
        />
        {canWrite && assets.length > 0 ? (
          <p className="assets-drop__hint">Drop files anywhere on this list to upload them.</p>
        ) : null}
      </div>

      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        tone="danger"
        title={`Remove ${removing?.name ?? 'this file'}?`}
        body="The file is deleted from the project's storage. This cannot be undone."
        confirmLabel={`Remove ${removing?.name ?? 'file'}`}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await deleteAsset(projectId, removing.id);
          } catch (cause) {
            throw new Error(
              cause instanceof ApiError ? cause.message : 'The file could not be removed.',
            );
          }
          toast({ tone: 'success', title: `Removed ${removing.name}` });
          listed.reload();
        }}
      />
    </section>
  );
}
