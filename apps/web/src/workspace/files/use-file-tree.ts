import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { joinPath, parentOf, type FileEntry } from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import {
  createDirectory,
  deletePath,
  fetchFileContent,
  fetchFileTree,
  movePath,
  uploadFile,
  writeFile,
} from '../../lib/files-api.js';
import { ancestorsOf, buildTree, type TreeNode } from './build-tree.js';
import { uploadAll, type UploadItem, type UploadOutcome, type UploadProgress } from './upload.js';

export type TreeStatus = 'loading' | 'ready' | 'error';

export interface FileTreeState {
  status: TreeStatus;
  message?: string;
  roots: TreeNode[];
  entries: FileEntry[];
  totalBytes: number;
  expanded: ReadonlySet<string>;
  toggle: (path: string) => void;
  reveal: (path: string) => void;
  collapseAll: () => void;
  reload: () => void;
  /** Resolves with the new entry, so the caller can open it. */
  createFile: (path: string) => Promise<FileEntry>;
  createFolder: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  /** Stores files from the person's device, one reload for the whole batch. */
  upload: (items: readonly UploadItem[], onProgress?: UploadProgress) => Promise<UploadOutcome>;
  /** Writes a copy of a file's content at another path. */
  copy: (from: string, to: string) => Promise<void>;
}

/** Where the open folders are remembered, per project (design spec 9.4). */
export const expansionKey = (projectId: string): string => `workspace.tree.${projectId}`;

function readExpansion(projectId: string): Set<string> {
  try {
    const raw = localStorage.getItem(expansionKey(projectId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []);
  } catch {
    // Storage can be blocked or hold something else; the tree just starts closed.
    return new Set();
  }
}

function writeExpansion(projectId: string, expanded: ReadonlySet<string>): void {
  try {
    localStorage.setItem(expansionKey(projectId), JSON.stringify([...expanded]));
  } catch {
    // Remembering is a convenience; a full or blocked store loses nothing else.
  }
}

/**
 * The project's file tree, and the operations on it.
 *
 * Every mutation reloads the tree rather than patching it locally. Moving a
 * directory changes the path of everything under it and deleting one removes
 * an unknown number of rows, so a local patch would have to reimplement the
 * server's rules and would drift from them. The tree carries no file content,
 * so reloading it is cheap, and these are discrete actions rather than
 * keystrokes.
 */
export function useFileTree(projectId: string, onChanged?: () => void): FileTreeState {
  const [status, setStatus] = useState<TreeStatus>('loading');
  const [message, setMessage] = useState<string | undefined>();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => readExpansion(projectId));
  const [nonce, setNonce] = useState(0);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  useEffect(() => writeExpansion(projectId, expanded), [projectId, expanded]);

  useEffect(() => {
    const controller = new AbortController();

    fetchFileTree(projectId, controller.signal)
      .then((tree) => {
        setEntries(tree.entries);
        setTotalBytes(tree.totalBytes);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStatus('error');
        setMessage(error instanceof ApiError ? error.message : 'The files could not be loaded.');
      });

    return () => controller.abort();
  }, [projectId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const toggle = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  /** Opens every folder on the way to a path, so a new file is visible. */
  const reveal = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      for (const ancestor of ancestorsOf(path)) next.add(ancestor);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  const roots = useMemo(() => buildTree(entries), [entries]);

  /**
   * Runs a mutation and reloads.
   *
   * Errors are not swallowed: the caller shows them beside the control the
   * person was using, which is the only place the message makes sense. The
   * workspace is told as well, because a new file can change which language
   * the project runs (`onFilesChanged`).
   */
  const mutate = useCallback(
    async <T>(work: () => Promise<T>, revealPath?: string): Promise<T> => {
      const result = await work();
      if (revealPath) reveal(revealPath);
      reload();
      changed.current?.();
      return result;
    },
    [reload, reveal],
  );

  const createFile = useCallback(
    (path: string) =>
      // An empty file, which is what "new file" means everywhere else.
      mutate(() => writeFile(projectId, { path, content: '' }), path),
    [mutate, projectId],
  );

  const createFolder = useCallback(
    (path: string) =>
      mutate(
        async () => {
          await createDirectory(projectId, path);
        },
        joinPath(path, 'x'),
      ),
    [mutate, projectId],
  );

  const rename = useCallback(
    (from: string, to: string) =>
      mutate(async () => {
        await movePath(projectId, from, to);
      }, to),
    [mutate, projectId],
  );

  const remove = useCallback(
    (path: string) =>
      mutate(async () => {
        await deletePath(projectId, path);
        // Collapsing what is gone keeps the expansion set from growing with
        // paths that no longer exist.
        setExpanded((current) => {
          const next = new Set(current);
          for (const open of current) {
            if (open === path || open.startsWith(`${path}/`)) next.delete(open);
          }
          return next;
        });
      }),
    [mutate, projectId],
  );

  const upload = useCallback(
    async (items: readonly UploadItem[], onProgress?: UploadProgress) => {
      const outcome = await uploadAll(
        items,
        (item) => uploadFile(projectId, item.path, item.file),
        onProgress,
      );
      // Reloaded even when some failed: the ones before the failure are stored.
      if (outcome.uploaded.length > 0) {
        reveal(outcome.uploaded[0]!);
        reload();
        changed.current?.();
      }
      return outcome;
    },
    [projectId, reload, reveal],
  );

  const copy = useCallback(
    (from: string, to: string) =>
      mutate(async () => {
        // Same encoding back, so a binary file stays byte for byte the same.
        const source = await fetchFileContent(projectId, from);
        await writeFile(projectId, {
          path: to,
          content: source.content,
          encoding: source.encoding,
        });
      }, to),
    [mutate, projectId],
  );

  return {
    status,
    ...(message === undefined ? {} : { message }),
    roots,
    entries,
    totalBytes,
    expanded,
    toggle,
    reveal,
    collapseAll,
    reload,
    createFile,
    createFolder,
    rename,
    remove,
    upload,
    copy,
  };
}

/** The directory a new entry should go into, given what is selected. */
export function targetDirectory(
  selected: string | undefined,
  entries: readonly FileEntry[],
): string {
  if (!selected) return '';
  const entry = entries.find((candidate) => candidate.path === selected);
  if (!entry) return '';
  // Creating next to a selected file means creating beside it, not inside it.
  return entry.type === 'DIRECTORY' ? entry.path : parentOf(entry.path);
}
