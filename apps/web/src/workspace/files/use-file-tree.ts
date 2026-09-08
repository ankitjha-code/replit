import { useCallback, useEffect, useMemo, useState } from 'react';
import { joinPath, parentOf, type FileEntry } from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import {
  createDirectory,
  deletePath,
  fetchFileTree,
  movePath,
  writeFile,
} from '../../lib/files-api.js';
import { ancestorsOf, buildTree, type TreeNode } from './build-tree.js';

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
  reload: () => void;
  createFile: (path: string) => Promise<void>;
  createFolder: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
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
export function useFileTree(projectId: string): FileTreeState {
  const [status, setStatus] = useState<TreeStatus>('loading');
  const [message, setMessage] = useState<string | undefined>();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [nonce, setNonce] = useState(0);

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

  const roots = useMemo(() => buildTree(entries), [entries]);

  /**
   * Runs a mutation and reloads.
   *
   * Errors are not swallowed: the caller shows them beside the control the
   * person was using, which is the only place the message makes sense.
   */
  const mutate = useCallback(
    async (work: () => Promise<void>, revealPath?: string) => {
      await work();
      if (revealPath) reveal(revealPath);
      reload();
    },
    [reload, reveal],
  );

  const createFile = useCallback(
    (path: string) =>
      // An empty file, which is what "new file" means everywhere else.
      mutate(async () => {
        await writeFile(projectId, { path, content: '' });
      }, path),
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

  return {
    status,
    ...(message === undefined ? {} : { message }),
    roots,
    entries,
    totalBytes,
    expanded,
    toggle,
    reveal,
    reload,
    createFile,
    createFolder,
    rename,
    remove,
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
