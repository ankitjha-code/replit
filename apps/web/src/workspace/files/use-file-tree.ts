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
  createFile: (path: string) => Promise<FileEntry>;
  createFolder: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  upload: (items: readonly UploadItem[], onProgress?: UploadProgress) => Promise<UploadOutcome>;
  copy: (from: string, to: string) => Promise<void>;
}

export const expansionKey = (projectId: string): string => `workspace.tree.${projectId}`;

function readExpansion(projectId: string): Set<string> {
  try {
    const raw = localStorage.getItem(expansionKey(projectId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeExpansion(projectId: string, expanded: ReadonlySet<string>): void {
  try {
    localStorage.setItem(expansionKey(projectId), JSON.stringify([...expanded]));
  } catch {}
}

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

  const reveal = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      for (const ancestor of ancestorsOf(path)) next.add(ancestor);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  const roots = useMemo(() => buildTree(entries), [entries]);

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
    (path: string) => mutate(() => writeFile(projectId, { path, content: '' }), path),
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

export function targetDirectory(
  selected: string | undefined,
  entries: readonly FileEntry[],
): string {
  if (!selected) return '';
  const entry = entries.find((candidate) => candidate.path === selected);
  if (!entry) return '';
  return entry.type === 'DIRECTORY' ? entry.path : parentOf(entry.path);
}
