import { useEffect, useState } from 'react';
import {
  PATH_PROBLEM_MESSAGES,
  joinPath,
  normalizePath,
  parentOf,
  roleHasPermission,
  type FileEntry,
  type ProjectRole,
  type WorkspaceSyncResult,
} from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import { PanelPlaceholder } from '../Panel.js';
import { FileTree } from './FileTree.js';
import { syncRuntimeFiles } from '../../lib/runtime-api.js';
import { targetDirectory, useFileTree } from './use-file-tree.js';

export interface FilesPanelProps {
  projectId: string;
  role: ProjectRole;
  selected: string | undefined;
  onSelect: (entry: FileEntry) => void;
  /** True when a runtime is up and its files can be read back. */
  runtimeRunning: boolean;
  /**
   * Bumped when somebody else changed the project's files.
   *
   * A number rather than a list of what changed. Every mutation in this panel
   * already reloads the whole tree rather than patching it, for the reason
   * given on `useFileTree`, and a change from elsewhere is no different.
   */
  reloadNonce: number;
}

type Pending = { kind: 'file' | 'folder'; directory: string } | undefined;

/**
 * What a sync did, in one line.
 *
 * "Nothing changed" is a real answer and the commonest one. Saying it beats
 * leaving someone to wonder whether the button worked.
 */
function describeSync(result: WorkspaceSyncResult): string {
  const parts = [
    result.created > 0 ? `${result.created} added` : undefined,
    result.updated > 0 ? `${result.updated} updated` : undefined,
    result.deleted > 0 ? `${result.deleted} removed` : undefined,
  ].filter((part): part is string => part !== undefined);

  if (parts.length === 0) return 'Nothing changed in the runtime.';
  return `Read back from the runtime: ${parts.join(', ')}.`;
}

/**
 * The project's files.
 *
 * Write controls are hidden when the caller's role does not allow writing.
 * That is a rendering decision only: the server refuses the request regardless,
 * so hiding the button spares someone an error rather than granting anything.
 */
export function FilesPanel(props: FilesPanelProps): React.JSX.Element {
  const tree = useFileTree(props.projectId);
  const canWrite = roleHasPermission(props.role, 'file:write');

  /*
   * Reload when somebody else changes something.
   *
   * Skipped on the first render: the hook above has already loaded the tree,
   * and reloading it immediately would be a second request for what is on
   * screen. `reload` is stable, so this runs only when the nonce moves.
   */
  const firstNonce = useState(props.reloadNonce)[0];
  useEffect(() => {
    if (props.reloadNonce === firstNonce) return;
    tree.reload();
  }, [props.reloadNonce, firstNonce, tree.reload]);

  /**
   * The last entry the person interacted with, file or folder.
   *
   * Separate from the selected file the workspace tracks: clicking a folder
   * means "work here", but a folder is not something the editor can open. New
   * entries land beside or inside whatever this is.
   */
  const [active, setActive] = useState<string | undefined>();

  const [pending, setPending] = useState<Pending>();
  const [renaming, setRenaming] = useState<string | undefined>();
  const [confirming, setConfirming] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [syncing, setSyncing] = useState(false);

  /**
   * Reads the runtime's files back into the project.
   *
   * An action rather than something that happens quietly, because it replaces
   * files that may be open in the editor. What it did is reported: "nothing
   * changed" is a useful answer and an invisible one otherwise.
   */
  const sync = async (): Promise<void> => {
    setSyncing(true);
    setError(undefined);
    setNotice(undefined);

    try {
      const result = await syncRuntimeFiles(props.projectId);
      tree.reload();
      setNotice(describeSync(result));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The files could not be read back.');
    } finally {
      setSyncing(false);
    }
  };

  /** Runs an operation, turning a rejection into a message beside the tree. */
  const attempt = async (work: () => Promise<void>): Promise<void> => {
    setError(undefined);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'That did not work. Please try again.');
    }
  };

  const startCreating = (kind: 'file' | 'folder'): void => {
    setError(undefined);
    setPending({ kind, directory: targetDirectory(active ?? props.selected, tree.entries) });
  };

  const submitCreate = async (name: string): Promise<void> => {
    const current = pending;
    setPending(undefined);
    if (!current) return;

    const trimmed = name.trim();
    if (trimmed.length === 0) return;

    // Checked here so an obviously bad name is refused without a round trip.
    // The server checks again and its answer is the one that counts.
    const path = joinPath(current.directory, trimmed);
    const validated = normalizePath(path);
    if (!validated.ok) {
      setError(PATH_PROBLEM_MESSAGES[validated.problem ?? 'empty']);
      return;
    }

    await attempt(() =>
      current.kind === 'file'
        ? tree.createFile(validated.path!)
        : tree.createFolder(validated.path!),
    );
  };

  const submitRename = async (from: string, name: string): Promise<void> => {
    setRenaming(undefined);

    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed === from.split('/').pop()) return;

    // A name containing separators moves the entry, which is how a rename
    // reaches a different folder without a pointing device.
    const to = joinPath(parentOf(from), trimmed);
    const validated = normalizePath(to);
    if (!validated.ok) {
      setError(PATH_PROBLEM_MESSAGES[validated.problem ?? 'empty']);
      return;
    }

    await attempt(() => tree.rename(from, validated.path!));
  };

  return (
    <div className="files-panel">
      {canWrite && (
        <div className="files-panel__toolbar">
          <button type="button" className="icon-button" onClick={() => startCreating('file')}>
            New file
          </button>
          <button type="button" className="icon-button" onClick={() => startCreating('folder')}>
            New folder
          </button>
          {/* Only when there is something to read from. A button that always
              refuses would be a worse way of saying nothing is running. */}
          {props.runtimeRunning && (
            <button
              type="button"
              className="icon-button"
              disabled={syncing}
              title="Read files created or changed by commands back into the project"
              onClick={() => void sync()}
            >
              {syncing ? 'Reading…' : 'Read from runtime'}
            </button>
          )}
        </div>
      )}

      {notice && (
        <p className="files-panel__note" role="status">
          {notice}
        </p>
      )}

      {error && (
        <p className="files-panel__error" role="alert">
          {error}
        </p>
      )}

      {tree.status === 'loading' && <p className="files-panel__note">Loading files…</p>}

      {tree.status === 'error' && (
        <div className="files-panel__error" role="alert">
          <p>{tree.message}</p>
          <button type="button" className="icon-button" onClick={tree.reload}>
            Try again
          </button>
        </div>
      )}

      {tree.status === 'ready' && (
        <>
          {pending && (
            <NewEntryInput
              kind={pending.kind}
              directory={pending.directory}
              onSubmit={submitCreate}
              onCancel={() => setPending(undefined)}
            />
          )}

          {tree.roots.length === 0 && !pending ? (
            <PanelPlaceholder
              headline="No files yet"
              detail={
                canWrite
                  ? 'Create a file to get started.'
                  : 'This project has no files, and your access does not allow adding any.'
              }
            />
          ) : (
            <FileTree
              roots={tree.roots}
              expanded={tree.expanded}
              selected={props.selected}
              renaming={renaming}
              canWrite={canWrite}
              onToggle={(path) => {
                setActive(path);
                tree.toggle(path);
              }}
              onSelect={(entry) => {
                setActive(entry.path);
                props.onSelect(entry);
              }}
              onRenameStart={setRenaming}
              onRenameSubmit={(from, name) => void submitRename(from, name)}
              onRenameCancel={() => setRenaming(undefined)}
              onMove={(from, directory) =>
                void attempt(() => tree.rename(from, joinPath(directory, from.split('/').pop()!)))
              }
              onDelete={setConfirming}
            />
          )}
        </>
      )}

      {confirming && (
        <ConfirmDelete
          path={confirming}
          onCancel={() => setConfirming(undefined)}
          onConfirm={() => {
            const path = confirming;
            setConfirming(undefined);
            void attempt(() => tree.remove(path));
          }}
        />
      )}
    </div>
  );
}

function NewEntryInput({
  kind,
  directory,
  onSubmit,
  onCancel,
}: {
  kind: 'file' | 'folder';
  directory: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const label = kind === 'file' ? 'New file name' : 'New folder name';

  return (
    <div className="files-panel__new">
      <label htmlFor="new-entry" className="files-panel__new-label">
        {label}
        {directory && <span className="files-panel__new-in"> in {directory}</span>}
      </label>
      <input
        id="new-entry"
        className="file-row__input"
        autoFocus
        placeholder={kind === 'file' ? 'index.js' : 'src'}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSubmit((event.target as HTMLInputElement).value);
          if (event.key === 'Escape') onCancel();
        }}
        onBlur={(event) => onSubmit(event.target.value)}
      />
    </div>
  );
}

/**
 * Confirmation before a delete.
 *
 * Inline rather than a native dialog: deleting a folder removes everything
 * inside it, and the message should say which folder, which a browser prompt
 * cannot be relied on to show clearly.
 */
function ConfirmDelete({
  path,
  onConfirm,
  onCancel,
}: {
  path: string;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <div className="files-panel__confirm" role="alertdialog" aria-label="Confirm delete">
      <p>
        Delete <strong>{path}</strong>? Anything inside it goes too, and this cannot be undone.
      </p>
      <div className="files-panel__confirm-actions">
        <button type="button" className="button-danger" onClick={onConfirm}>
          Delete
        </button>
        <button type="button" className="icon-button" onClick={onCancel} autoFocus>
          Cancel
        </button>
      </div>
    </div>
  );
}
