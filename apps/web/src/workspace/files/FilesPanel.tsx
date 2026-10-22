import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  PATH_PROBLEM_MESSAGES,
  joinPath,
  normalizePath,
  parentOf,
  type FileEntry,
  type ProjectRole,
  type WorkspaceSyncResult,
} from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import { copyText } from '../../lib/clipboard.js';
import { canWrite as roleCanWrite } from '../../lib/permissions.js';
import { syncRuntimeFiles } from '../../lib/runtime-api.js';
import { useAction } from '../../lib/use-action.js';
import {
  Button,
  Callout,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Menu,
  Progress,
  Skeleton,
  toast,
  type MenuItem,
} from '../../ui/index.js';
import {
  ArrowClockwise,
  ArrowsClockwise,
  DotsThree,
  FilePlus,
  FolderPlus,
  UploadSimple,
} from '../../ui/icons.js';
import { WORKSPACE_EVENTS } from '../shell/shortcuts.js';
import { useWorkspaceActions } from '../shell/workspace-actions.js';
import { FileContextMenu, fileMenuGroups, type FileMenuActions } from './FileContextMenu.js';
import { FileSearchInput, FileSearchResults, useFileSearch } from './FileSearch.js';
import { FileTree, InlineNameInput } from './FileTree.js';
import { MoveDialog } from './MoveDialog.js';
import { UploadDropZone, filesFromDataTransfer } from './UploadDropZone.js';
import { copyPathFor, saveToDevice } from './file-actions.js';
import { FILES_EVENTS } from './files-events.js';
import { describeUpload, planUpload, type UploadItem, type UploadRefusal } from './upload.js';
import { targetDirectory, useFileTree } from './use-file-tree.js';
import './files.css';

export interface FilesPanelProps {
  projectId: string;
  role: ProjectRole;
  selected: string | undefined;
  onSelect: (entry: FileEntry) => void;
  /** True when the environment is up and its files can be synced back. */
  runtimeRunning: boolean;
  /**
   * Bumped when somebody else changed the project's files.
   *
   * A number rather than a list of what changed. Every mutation in this panel
   * already reloads the whole tree rather than patching it, for the reason
   * given on `useFileTree`, and a change from elsewhere is no different.
   */
  reloadNonce: number;
  /** A path and everything under it was deleted here, so open tabs can follow. */
  onPathRemoved?: ((path: string) => void) | undefined;
  /** A path was renamed or moved here, so open tabs can follow. */
  onPathMoved?: ((from: string, to: string) => void) | undefined;
}

type Pending = { kind: 'file' | 'folder'; directory: string } | undefined;

interface PanelError {
  message: string;
  /** Runs the failed operation again, when that makes sense. */
  retry?: () => void;
}

interface Upload {
  done: number;
  total: number;
  current: string | undefined;
}

interface ReplaceRequest {
  items: UploadItem[];
  refused: UploadRefusal[];
  existing: string[];
}

/**
 * What a sync did, in one line.
 *
 * "Nothing new" is a real answer and the commonest one. Saying it beats
 * leaving someone to wonder whether the button worked.
 */
export function describeSync(result: WorkspaceSyncResult): string {
  const parts = [
    result.created > 0 ? `${result.created} added` : undefined,
    result.updated > 0 ? `${result.updated} updated` : undefined,
    result.deleted > 0 ? `${result.deleted} removed` : undefined,
  ].filter((part): part is string => part !== undefined);

  if (parts.length === 0) return 'Nothing new in the environment.';
  return `Synced from the environment: ${parts.join(', ')}.`;
}

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof ApiError ? cause.message : fallback;

/**
 * The editor opens by path and ignores the rest of the entry, so a search
 * result whose folder is closed can still be opened.
 */
function entryFor(path: string, entries: readonly FileEntry[]): FileEntry {
  return (
    entries.find((entry) => entry.path === path) ?? {
      path,
      name: path.split('/').pop() ?? path,
      type: 'FILE',
      size: 0,
      isBinary: false,
      version: 1,
      updatedAt: new Date(0).toISOString(),
    }
  );
}

/**
 * The project's files (design spec 9.4).
 *
 * Write controls are hidden when the caller's role does not allow writing.
 * That is a rendering decision only: the server refuses the request regardless,
 * so hiding the button spares someone an error rather than granting anything.
 */
export function FilesPanel(props: FilesPanelProps): ReactElement {
  const { projectId } = props;
  const workspace = useWorkspaceActions();
  const tree = useFileTree(projectId, workspace.onFilesChanged);
  const canWrite = roleCanWrite(props.role);

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
  const [moving, setMoving] = useState<string | undefined>();
  const [error, setError] = useState<PanelError | undefined>();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [upload, setUpload] = useState<Upload | undefined>();
  const [replacing, setReplacing] = useState<ReplaceRequest | undefined>();
  const [query, setQuery] = useState('');
  const search = useFileSearch(projectId, query);
  const searching = query.trim().length > 0;

  const searchRef = useRef<HTMLInputElement>(null);
  const treeAreaRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadDirectory = useRef('');

  const focusTree = (): void => {
    treeAreaRef.current?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.focus();
  };

  /**
   * After a dialog about a row closes, focus goes back to the row that opened
   * it. When that row is gone (deleted, moved away), the browser drops focus
   * on the page instead; this puts it back on the tree. It waits while focus
   * is still inside the closing dialog, which hands focus back only after its
   * exit animation, and gives up as soon as focus lands anywhere real.
   */
  const restoreTreeFocus = (): void => {
    let attempts = 0;
    const check = (): void => {
      const active = document.activeElement;
      if (!active || active === document.body) {
        focusTree();
        return;
      }
      if (active.closest('[data-ui-portal]') && attempts++ < 20) setTimeout(check, 50);
    };
    setTimeout(check, 50);
  };

  /**
   * Runs one operation on one path. The row shows a spinner and refuses a
   * second operation until this one is done; a failure goes in the callout
   * above the tree with a way to try again.
   */
  // A ref as well as state: two presses in one render must not both start.
  const busyNow = useRef(new Set<string>());
  const track = async (path: string, work: () => Promise<void>): Promise<void> => {
    if (busyNow.current.has(path)) return;
    busyNow.current.add(path);
    setError(undefined);
    setBusy(new Set(busyNow.current));
    try {
      await work();
    } catch (cause) {
      setError({
        message: messageOf(cause, 'That did not work. Please try again.'),
        retry: () => void track(path, work),
      });
    } finally {
      busyNow.current.delete(path);
      setBusy(new Set(busyNow.current));
    }
  };

  // --- sync --------------------------------------------------------------

  /**
   * Copies files created inside the environment back into the project.
   *
   * An action rather than something that happens quietly, because it replaces
   * files that may be open in the editor. What it did is reported: "nothing
   * new" is a useful answer and an invisible one otherwise.
   */
  const sync = useAction(() => syncRuntimeFiles(projectId));
  const runSync = async (): Promise<void> => {
    setError(undefined);
    const outcome = await sync.run();
    if (!outcome.ok) {
      setError({
        message: messageOf(outcome.error, 'The files could not be synced from the environment.'),
        retry: () => void runSync(),
      });
      return;
    }
    tree.reload();
    workspace.onFilesChanged();
    const changed = outcome.value.created + outcome.value.updated + outcome.value.deleted;
    toast({ tone: changed > 0 ? 'success' : 'info', title: describeSync(outcome.value) });
  };

  // --- create and rename -------------------------------------------------

  const startCreating = (kind: 'file' | 'folder', directory?: string): void => {
    if (!canWrite) return;
    const where = directory ?? targetDirectory(active ?? props.selected, tree.entries);
    setError(undefined);
    setQuery('');
    setRenaming(undefined);
    if (where) tree.reveal(joinPath(where, 'x'));
    setPending({ kind, directory: where });
  };

  const create = async (kind: 'file' | 'folder', path: string): Promise<void> => {
    try {
      if (kind === 'folder') {
        await tree.createFolder(path);
        setActive(path);
        return;
      }
      const entry = await tree.createFile(path);
      // Created to be written in, so it opens straight away.
      setActive(entry.path);
      props.onSelect(entry);
    } catch (cause) {
      setError({
        message: messageOf(cause, 'That did not work. Please try again.'),
        retry: () => void create(kind, path),
      });
    }
  };

  const submitCreate = (name: string): void => {
    const current = pending;
    setPending(undefined);
    if (!current) return;

    const trimmed = name.trim();
    if (trimmed.length === 0) return;

    // Checked here so an obviously bad name is refused without a round trip.
    // The server checks again and its answer is the one that counts.
    const validated = normalizePath(joinPath(current.directory, trimmed));
    if (!validated.ok) {
      setError({ message: PATH_PROBLEM_MESSAGES[validated.problem ?? 'empty'] });
      return;
    }
    setError(undefined);
    void create(current.kind, validated.path!);
  };

  const submitRename = (from: string, name: string): void => {
    setRenaming(undefined);

    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed === from.split('/').pop()) return;

    // A name containing separators moves the entry, which is how a rename
    // reaches a different folder without a pointing device.
    const validated = normalizePath(joinPath(parentOf(from), trimmed));
    if (!validated.ok) {
      setError({ message: PATH_PROBLEM_MESSAGES[validated.problem ?? 'empty'] });
      return;
    }
    void track(from, () => renameTo(from, validated.path!));
  };

  const renameTo = async (from: string, to: string): Promise<void> => {
    await tree.rename(from, to);
    props.onPathMoved?.(from, to);
  };

  const moveInto = (from: string, directory: string): Promise<void> =>
    renameTo(from, joinPath(directory, from.split('/').pop()!));

  // --- upload --------------------------------------------------------------

  const runUpload = async (items: UploadItem[], refused: UploadRefusal[]): Promise<void> => {
    setUpload({ done: 0, total: items.length, current: items[0]?.path });
    const outcome = await tree.upload(items, (done, total, current) =>
      setUpload({ done, total, current }),
    );
    setUpload(undefined);
    toast({ id: 'files-upload', ...describeUpload(outcome, refused) });
  };

  const startUpload = (files: File[], directory: string, folders: string[] = []): void => {
    if (!canWrite || upload) return;
    const plan = planUpload(files, directory);
    const refused = [
      ...plan.refused,
      ...folders.map((name) => ({
        name,
        reason: 'Folders cannot be uploaded. Drop the files inside it instead.',
      })),
    ];
    const kinds = new Map(tree.entries.map((entry) => [entry.path, entry.type]));
    const items: UploadItem[] = [];
    for (const item of plan.items) {
      if (kinds.get(item.path) === 'DIRECTORY') {
        refused.push({ name: item.path, reason: 'A folder with that name is already there.' });
      } else {
        items.push(item);
      }
    }

    if (items.length === 0) {
      toast({ id: 'files-upload', ...describeUpload({ uploaded: [], failed: [] }, refused) });
      return;
    }
    // Uploading over a file replaces it, so ask first, naming what goes.
    const existing = items.filter((item) => kinds.get(item.path) === 'FILE').map((i) => i.path);
    if (existing.length > 0) {
      setReplacing({ items, refused, existing });
      return;
    }
    void runUpload(items, refused);
  };

  const openPicker = (directory: string): void => {
    uploadDirectory.current = directory;
    fileInputRef.current?.click();
  };

  const dropFiles = (data: DataTransfer, directory: string): void => {
    // Read now: the browser empties the DataTransfer when the event returns.
    const dropped = filesFromDataTransfer(data);
    startUpload(dropped.files, directory, dropped.folders);
  };

  // --- menus -------------------------------------------------------------

  /*
   * Items that open an inline field wait for the menu to close. Radix gives
   * focus back to whatever opened the menu as it closes, which would pull
   * focus straight out of a field opened from `onSelect`; at that moment the
   * field is opened instead, and the return is cancelled.
   */
  const afterMenu = useRef<(() => void) | undefined>(undefined);
  const onMenuCloseAutoFocus = (event: Event): void => {
    const start = afterMenu.current;
    if (!start) return;
    afterMenu.current = undefined;
    event.preventDefault();
    start();
  };

  const menuActions: FileMenuActions = {
    newFile: (directory) => {
      afterMenu.current = () => startCreating('file', directory);
    },
    newFolder: (directory) => {
      afterMenu.current = () => startCreating('folder', directory);
    },
    // Straight away: the file picker needs the click that chose the item.
    upload: (directory) => openPicker(directory),
    rename: (path) => {
      afterMenu.current = () => {
        setPending(undefined);
        setRenaming(path);
      };
    },
    duplicate: (path) => void track(path, () => tree.copy(path, copyPathFor(path, tree.entries))),
    move: (path) => setMoving(path),
    copyPath: (path) =>
      void copyText(path).then((copied) =>
        toast(
          copied
            ? { tone: 'success', title: `Copied ${path}` }
            : { tone: 'danger', title: 'Could not copy the path', description: path },
        ),
      ),
    download: (path) => void track(path, () => saveToDevice(projectId, path)),
    remove: (path) => setConfirming(path),
  };

  const overflow: MenuItem[] = [
    ...(canWrite && props.runtimeRunning
      ? [
          {
            id: 'sync',
            label: sync.busy ? 'Syncing…' : 'Sync files',
            icon: ArrowsClockwise,
            onSelect: () => void runSync(),
            ...(sync.busy ? { disabledReason: 'A sync is already running.' } : {}),
          },
        ]
      : []),
    {
      id: 'collapse',
      label: 'Collapse all',
      onSelect: tree.collapseAll,
      ...(tree.expanded.size === 0 ? { disabledReason: 'No folders are open.' } : {}),
    },
    { id: 'reload', label: 'Reload', icon: ArrowClockwise, onSelect: tree.reload },
  ];

  // --- events from the workspace frame (palette, Ctrl+Shift+F) -------------

  const handlers = useRef<
    Record<'newFile' | 'newFolder' | 'search' | 'upload' | 'sync', () => void>
  >(undefined!);
  handlers.current = {
    newFile: () => startCreating('file'),
    newFolder: () => startCreating('folder'),
    search: () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    },
    upload: () => {
      if (canWrite) openPicker(targetDirectory(active ?? props.selected, tree.entries));
    },
    sync: () => {
      if (canWrite && props.runtimeRunning) void runSync();
    },
  };

  useEffect(() => {
    const listeners: Array<[string, () => void]> = [
      [WORKSPACE_EVENTS.newFile, () => handlers.current.newFile()],
      [WORKSPACE_EVENTS.newFolder, () => handlers.current.newFolder()],
      [WORKSPACE_EVENTS.searchFiles, () => handlers.current.search()],
      [FILES_EVENTS.upload, () => handlers.current.upload()],
      [FILES_EVENTS.sync, () => handlers.current.sync()],
    ];
    for (const [name, listener] of listeners) document.addEventListener(name, listener);
    return () => {
      for (const [name, listener] of listeners) document.removeEventListener(name, listener);
    };
  }, []);

  // --- render --------------------------------------------------------------

  const open = (entry: FileEntry): void => {
    setActive(entry.path);
    props.onSelect(entry);
  };

  const confirmingEntry = tree.entries.find((entry) => entry.path === confirming);
  const confirmingFolder = confirmingEntry?.type === 'DIRECTORY';

  return (
    <UploadDropZone enabled={canWrite} onDrop={dropFiles} className="files">
      <div className="files__bar">
        <FileSearchInput
          value={query}
          onChange={setQuery}
          inputRef={searchRef}
          onLeave={(direction) => {
            if (direction === 'down' && searching) {
              treeAreaRef.current?.querySelector<HTMLElement>('.files-result')?.focus();
              return;
            }
            focusTree();
          }}
        />
        <div className="files__actions">
          {canWrite ? (
            <>
              <IconButton
                size="sm"
                label="New file"
                icon={FilePlus}
                onClick={() => startCreating('file')}
              />
              <IconButton
                size="sm"
                label="New folder"
                icon={FolderPlus}
                onClick={() => startCreating('folder')}
              />
              <IconButton
                size="sm"
                label="Upload files"
                icon={UploadSimple}
                loading={upload !== undefined}
                onClick={() => openPicker(targetDirectory(active ?? props.selected, tree.entries))}
              />
            </>
          ) : null}
          <Menu
            label="More file actions"
            items={overflow}
            trigger={<IconButton size="sm" label="More file actions" icon={DotsThree} />}
          />
        </div>
      </div>

      {error ? (
        <Callout
          tone="danger"
          className="files-callout"
          title={error.message}
          onDismiss={() => setError(undefined)}
          action={
            error.retry ? (
              <Button size="sm" onClick={error.retry}>
                Retry
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {upload ? (
        <div className="files-upload">
          <Progress value={upload.done} max={upload.total} label="Uploading files" />
          <p className="files-upload__text" aria-live="polite">
            Uploading {Math.min(upload.done + 1, upload.total)} of {upload.total}
            {upload.current ? `: ${upload.current}` : ''}
          </p>
        </div>
      ) : null}

      {pending ? (
        <div className="files-new">
          {pending.directory ? (
            <span className="files-new__prefix">{pending.directory}/</span>
          ) : null}
          <InlineNameInput
            key={`${pending.kind}:${pending.directory}`}
            label={`${pending.kind === 'file' ? 'New file name' : 'New folder name'}${
              pending.directory ? ` in ${pending.directory}/` : ''
            }`}
            placeholder={pending.kind === 'file' ? 'index.js' : 'src'}
            className="files-new__input"
            onSubmit={submitCreate}
            onCancel={() => setPending(undefined)}
          />
        </div>
      ) : null}

      <div className="files__body" ref={treeAreaRef}>
        {searching ? (
          <FileSearchResults
            query={query}
            search={search}
            onOpen={(path) => open(entryFor(path, tree.entries))}
          />
        ) : tree.status === 'loading' ? (
          <div className="files-loading" aria-busy="true" aria-label="Loading files">
            {[64, 48, 72, 56, 40].map((width, index) => (
              <Skeleton
                key={index}
                shape="row"
                width={`${width}%`}
                className="files-loading__row"
              />
            ))}
          </div>
        ) : tree.status === 'error' ? (
          <Callout
            tone="danger"
            className="files-callout"
            title={tree.message ?? 'The files could not be loaded.'}
            action={
              <Button size="sm" onClick={tree.reload}>
                Try again
              </Button>
            }
          />
        ) : (
          <FileContextMenu
            entries={tree.entries}
            canWrite={canWrite}
            actions={menuActions}
            className="files__tree-area"
            onCloseAutoFocus={onMenuCloseAutoFocus}
          >
            {tree.roots.length === 0 && !pending ? (
              <EmptyState
                icon={FilePlus}
                title="No files yet"
                body={
                  canWrite
                    ? 'Create a file, or drop files here to upload them.'
                    : 'This project has no files, and your access does not allow adding any.'
                }
                action={
                  canWrite ? (
                    <Button size="md" icon={FilePlus} onClick={() => startCreating('file', '')}>
                      Create a file
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <FileTree
                roots={tree.roots}
                expanded={tree.expanded}
                selected={props.selected}
                renaming={renaming}
                canWrite={canWrite}
                busy={busy}
                onToggle={(path) => {
                  setActive(path);
                  tree.toggle(path);
                }}
                onSelect={open}
                onRenameStart={(path) => {
                  setPending(undefined);
                  setRenaming(path);
                }}
                onRenameSubmit={submitRename}
                onRenameCancel={() => setRenaming(undefined)}
                onMove={(from, directory) => void track(from, () => moveInto(from, directory))}
                onDelete={setConfirming}
                onDropFiles={dropFiles}
                menuGroups={(entry) => fileMenuGroups(entry, canWrite, menuActions)}
                onMenuCloseAutoFocus={onMenuCloseAutoFocus}
              />
            )}
          </FileContextMenu>
        )}
      </div>

      {canWrite ? (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            // Cleared so choosing the same file again still fires a change.
            event.target.value = '';
            if (files.length > 0) startUpload(files, uploadDirectory.current);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={confirming !== undefined}
        onOpenChange={(next) => {
          if (next) return;
          setConfirming(undefined);
          restoreTreeFocus();
        }}
        ariaLabel="Confirm delete"
        title={confirmingFolder ? 'Delete this folder?' : 'Delete this file?'}
        tone="danger"
        confirmLabel="Delete"
        body={
          <p>
            Delete <strong>{confirming}</strong>?{' '}
            {confirmingFolder
              ? 'Anything inside it goes too, and this cannot be undone.'
              : 'This cannot be undone.'}
          </p>
        }
        onConfirm={async () => {
          const path = confirming;
          if (!path) return;
          await tree.remove(path);
          props.onPathRemoved?.(path);
          toast({ tone: 'success', title: `Deleted ${path}` });
        }}
      />

      <ConfirmDialog
        open={replacing !== undefined}
        onOpenChange={(next) => {
          if (!next) setReplacing(undefined);
        }}
        title="Replace existing files?"
        confirmLabel={
          replacing?.existing.length === 1
            ? `Replace ${replacing.existing[0]}`
            : `Replace ${replacing?.existing.length ?? 0} files`
        }
        body={
          <p>
            {replacing?.existing.length === 1 ? 'A file' : 'Files'} with the same name already
            exist: <strong>{replacing?.existing.join(', ')}</strong>. Uploading replaces{' '}
            {replacing?.existing.length === 1 ? 'it' : 'them'}.
          </p>
        }
        onConfirm={async () => {
          const request = replacing;
          if (!request) return;
          // Not awaited: the dialog closes and the progress shows in the panel.
          void runUpload(request.items, request.refused);
        }}
      />

      <MoveDialog
        path={moving}
        entries={tree.entries}
        onMove={async (from, directory) => {
          await moveInto(from, directory);
        }}
        onClose={() => {
          setMoving(undefined);
          restoreTreeFocus();
        }}
      />
    </UploadDropZone>
  );
}
