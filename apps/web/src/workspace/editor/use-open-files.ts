import { useCallback, useEffect, useRef, useState } from 'react';
import { baseName, languageOf, type FileEntry } from '@platform/shared';
import { ApiError, apiRequest } from '../../lib/api-client.js';
import { SESSION_RESTORED_EVENT } from '../../lib/auth-context.js';
import { fetchFileContent, fetchFileTree, writeFile } from '../../lib/files-api.js';
import { useRegisterGuard } from '../../lib/navigation-guard.js';
import { DEBOUNCE_MS, MAX_WAIT_MS, classifyFailure, retryDelay } from './save-policy.js';

export const EDITOR_MAX_BYTES = 512 * 1024;

export type TabStatus = 'loading' | 'ready' | 'error' | 'unopenable';

export type SaveState = 'idle' | 'pending' | 'saving' | 'retrying' | 'conflict' | 'blocked';

export interface Conflict {
  theirContent: string;
  theirVersion: number;
}

export interface OpenFile {
  path: string;
  name: string;
  language: string;
  status: TabStatus;
  content: string;
  saved: string;
  version: number;
  saveState: SaveState;
  revision: number;
  savedAt?: number | undefined;
  conflict?: Conflict | undefined;
  message?: string | undefined;
  deleted?: boolean | undefined;
}

export function isDirty(file: OpenFile): boolean {
  return file.status === 'ready' && (file.content !== file.saved || file.deleted === true);
}

export interface OpenFilesState {
  files: OpenFile[];
  activePath: string | undefined;
  active: OpenFile | undefined;
  hasUnsaved: boolean;
  dirtyCount: number;
  online: boolean;
  open: (entry: FileEntry) => void;
  openPath: (path: string) => void;
  reload: (path: string) => void;
  close: (path: string) => void;
  activate: (path: string) => void;
  change: (path: string, content: string) => void;
  save: (path: string) => Promise<void>;
  saveActive: () => Promise<void>;
  flush: (path: string) => Promise<void>;
  flushAll: () => Promise<void>;
  keepMine: (path: string) => Promise<void>;
  useTheirs: (path: string) => void;
  pathRemoved: (path: string) => void;
  pathMoved: (from: string, to: string) => void;
  setShared: (path: string, shared: boolean) => void;
}

const storageKey = (projectId: string): string => `workspace.tabs.${projectId}`;

interface StoredTabs {
  paths: string[];
  active?: string;
}

function readStored(projectId: string): StoredTabs {
  try {
    const raw = window.localStorage.getItem(storageKey(projectId));
    if (!raw) return { paths: [] };

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { paths: [] };

    const candidate = parsed as Partial<StoredTabs>;
    const paths = Array.isArray(candidate.paths)
      ? candidate.paths.filter((value): value is string => typeof value === 'string')
      : [];

    return typeof candidate.active === 'string' ? { paths, active: candidate.active } : { paths };
  } catch {
    return { paths: [] };
  }
}

interface Timers {
  debounce?: ReturnType<typeof setTimeout>;
  ceiling?: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
}

export function useOpenFiles(projectId: string, canWrite: boolean): OpenFilesState {
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | undefined>();
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const restored = useRef(false);

  const inFlight = useRef(new Set<string>());

  const attempts = useRef(new Map<string, number>());
  const timers = useRef(new Map<string, Timers>());

  const latest = useRef<OpenFile[]>([]);

  const patch = useCallback((path: string, change: Partial<OpenFile>) => {
    const apply = (current: OpenFile[]): OpenFile[] =>
      current.map((file) => (file.path === path ? { ...file, ...change } : file));

    latest.current = apply(latest.current);
    setFiles(apply);
  }, []);

  const clearTimers = useCallback((path: string) => {
    const existing = timers.current.get(path);
    if (!existing) return;
    if (existing.debounce) clearTimeout(existing.debounce);
    if (existing.ceiling) clearTimeout(existing.ceiling);
    if (existing.retry) clearTimeout(existing.retry);
    timers.current.delete(path);
  }, []);

  const saveRef = useRef<(path: string, expectedVersion?: number) => Promise<void>>(async () => {});

  const schedule = useCallback((path: string) => {
    const existing = timers.current.get(path) ?? {};
    if (existing.debounce) clearTimeout(existing.debounce);

    existing.debounce = setTimeout(() => {
      void saveRef.current(path);
    }, DEBOUNCE_MS);

    existing.ceiling ??= setTimeout(() => {
      void saveRef.current(path);
    }, MAX_WAIT_MS);

    timers.current.set(path, existing);
  }, []);

  const load = useCallback(
    async (path: string) => {
      try {
        const response = await fetchFileContent(projectId, path);

        if (response.entry.isBinary) {
          patch(path, {
            status: 'unopenable',
            message: 'This file is not text, so it cannot be edited here.',
          });
          return;
        }
        if (response.entry.size > EDITOR_MAX_BYTES) {
          patch(path, {
            status: 'unopenable',
            message: 'This file is too large to open in the editor.',
          });
          return;
        }

        patch(path, {
          status: 'ready',
          content: response.content,
          saved: response.content,
          version: response.entry.version,
          saveState: 'idle',
          message: undefined,
          conflict: undefined,
          revision: (latest.current.find((f) => f.path === path)?.revision ?? 0) + 1,
        });
      } catch (error) {
        patch(path, {
          status: 'error',
          message: error instanceof ApiError ? error.message : 'This file could not be opened.',
        });
      }
    },
    [patch, projectId],
  );

  const recordConflict = useCallback(
    async (path: string) => {
      clearTimers(path);
      attempts.current.delete(path);

      try {
        const response = await fetchFileContent(projectId, path);
        patch(path, {
          saveState: 'conflict',
          conflict: {
            theirContent: response.content,
            theirVersion: response.entry.version,
          },
          message: 'This file changed elsewhere. Your text is safe; choose which version to keep.',
        });
      } catch {
        patch(path, {
          saveState: 'blocked',
          message: 'This file changed elsewhere and the other version could not be read.',
        });
      }
    },
    [clearTimers, patch, projectId],
  );

  const attemptSave = useCallback(
    async (path: string, expectedVersion?: number): Promise<void> => {
      const file = latest.current.find((candidate) => candidate.path === path);
      if (!file || file.status !== 'ready' || !canWrite) return;
      if (file.deleted) return;

      if (file.content === file.saved) {
        if (file.saveState !== 'idle') patch(path, { saveState: 'idle' });
        return;
      }
      if (file.saveState === 'conflict' && expectedVersion === undefined) return;
      if (file.saveState === 'blocked' && expectedVersion === undefined) return;
      if (inFlight.current.has(path)) return;

      const sending = file.content;
      inFlight.current.add(path);
      patch(path, { saveState: 'saving', message: undefined });

      try {
        const entry = await writeFile(projectId, {
          path,
          content: sending,
          expectedVersion: expectedVersion ?? file.version,
        });

        const current = latest.current.find((candidate) => candidate.path === path);
        if (current?.deleted) return;

        attempts.current.delete(path);
        clearTimers(path);

        const stillDirty = current !== undefined && current.content !== sending;

        patch(path, {
          saved: sending,
          version: entry.version,
          savedAt: Date.now(),
          saveState: stillDirty ? 'pending' : 'idle',
          conflict: undefined,
          message: undefined,
        });

        if (stillDirty) schedule(path);
      } catch (error) {
        if (latest.current.find((candidate) => candidate.path === path)?.deleted) return;
        const response = classifyFailure(error);

        if (response === 'conflict') {
          await recordConflict(path);
          return;
        }

        if (response === 'blocked') {
          clearTimers(path);
          attempts.current.delete(path);
          patch(path, {
            saveState: 'blocked',
            message: error instanceof ApiError ? error.message : 'This file could not be saved.',
          });
          return;
        }

        const attempt = (attempts.current.get(path) ?? 0) + 1;
        attempts.current.set(path, attempt);

        patch(path, {
          saveState: 'retrying',
          message:
            error instanceof ApiError && error.code !== 'SERVICE_UNAVAILABLE'
              ? error.message
              : undefined,
        });

        const existing = timers.current.get(path) ?? {};
        if (existing.retry) clearTimeout(existing.retry);
        existing.retry = setTimeout(() => {
          void saveRef.current(path);
        }, retryDelay(attempt));
        timers.current.set(path, existing);
      } finally {
        inFlight.current.delete(path);
      }
    },
    [canWrite, clearTimers, patch, projectId, recordConflict, schedule],
  );

  saveRef.current = attemptSave;

  const openPath = useCallback(
    (path: string) => {
      setActivePath(path);
      const existing = latest.current.find((file) => file.path === path);
      if (existing) {
        if (existing.status === 'error') {
          patch(path, { status: 'loading', message: undefined });
          void load(path);
        }
        return;
      }

      const add = (current: OpenFile[]): OpenFile[] => {
        if (current.some((file) => file.path === path)) return current;
        return [
          ...current,
          {
            path,
            name: baseName(path),
            language: languageOf(path),
            status: 'loading' as const,
            content: '',
            saved: '',
            version: 0,
            saveState: 'idle' as const,
            revision: 0,
          },
        ];
      };

      latest.current = add(latest.current);
      setFiles(add);
      void load(path);
    },
    [load, patch],
  );

  const open = useCallback((entry: FileEntry) => openPath(entry.path), [openPath]);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;

    const stored = readStored(projectId);
    for (const path of stored.paths) openPath(path);
    if (stored.active) setActivePath(stored.active);
  }, [projectId, openPath]);

  useEffect(() => {
    if (!restored.current) return;
    try {
      window.localStorage.setItem(
        storageKey(projectId),
        JSON.stringify({ paths: files.map((file) => file.path), active: activePath }),
      );
    } catch {}
  }, [projectId, files, activePath]);

  useEffect(() => {
    const goOnline = (): void => {
      setOnline(true);
      for (const file of latest.current) {
        if (file.saveState === 'retrying') {
          attempts.current.delete(file.path);
          void saveRef.current(file.path);
        }
      }
    };
    const goOffline = (): void => setOnline(false);

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const entry of pending.values()) {
        if (entry.debounce) clearTimeout(entry.debounce);
        if (entry.ceiling) clearTimeout(entry.ceiling);
        if (entry.retry) clearTimeout(entry.retry);
      }
      pending.clear();
    };
  }, []);

  const close = useCallback(
    (path: string) => {
      clearTimers(path);
      attempts.current.delete(path);

      const current = latest.current;
      const remaining = current.filter((file) => file.path !== path);

      setActivePath((active) => {
        if (active !== path) return active;
        const index = current.findIndex((file) => file.path === path);
        return remaining[Math.min(index, remaining.length - 1)]?.path;
      });

      latest.current = remaining;
      setFiles(remaining);
    },
    [clearTimers],
  );

  const shared = useRef(new Set<string>());

  const setShared = useCallback(
    (path: string, on: boolean) => {
      const held = shared.current.has(path);
      if (held === on) return;

      if (on) {
        shared.current.add(path);
        clearTimers(path);
        const file = latest.current.find((candidate) => candidate.path === path);
        if (file) patch(path, { saved: file.content, saveState: 'idle', message: undefined });
        return;
      }

      shared.current.delete(path);
    },
    [clearTimers, patch],
  );

  const change = useCallback(
    (path: string, content: string) => {
      if (!canWrite) return;
      if (shared.current.has(path)) return;

      const file = latest.current.find((candidate) => candidate.path === path);
      if (!file || file.content === content) return;

      const clean = content === file.saved && !file.deleted;
      const waiting =
        file.saveState === 'conflict' || file.saveState === 'blocked' || file.deleted === true;

      patch(path, {
        content,
        ...(clean
          ? { saveState: 'idle' as const, conflict: undefined, message: undefined }
          : waiting
            ? {}
            : { saveState: 'pending' as const }),
      });

      if (clean) {
        clearTimers(path);
        return;
      }

      if (waiting) return;
      schedule(path);
    },
    [canWrite, clearTimers, patch, schedule],
  );

  const recreate = useCallback(
    async (path: string) => {
      const file = latest.current.find((candidate) => candidate.path === path);
      if (!file?.deleted || !canWrite || inFlight.current.has(path)) return;

      inFlight.current.add(path);
      const sending = file.content;
      patch(path, { saveState: 'saving', message: undefined });
      try {
        const tree = await fetchFileTree(projectId);
        const taken = tree.entries.some((entry) => entry.path === path);
        if (taken) {
          patch(path, {
            saveState: 'idle',
            message: `Something is at ${path} again, so your text was not saved over it. Copy it, or close this tab.`,
          });
          return;
        }
        const entry = await writeFile(projectId, { path, content: sending });
        const current = latest.current.find((candidate) => candidate.path === path);
        const stillDirty = current !== undefined && current.content !== sending;
        patch(path, {
          deleted: undefined,
          saved: sending,
          version: entry.version,
          savedAt: Date.now(),
          saveState: stillDirty ? 'pending' : 'idle',
          message: undefined,
        });
        if (stillDirty) schedule(path);
      } catch (error) {
        patch(path, {
          saveState: 'idle',
          message: error instanceof ApiError ? error.message : 'This file could not be saved.',
        });
      } finally {
        inFlight.current.delete(path);
      }
    },
    [canWrite, patch, projectId, schedule],
  );

  const save = useCallback(
    async (path: string) => {
      clearTimers(path);
      if (latest.current.find((file) => file.path === path)?.deleted) {
        await recreate(path);
        return;
      }
      await attemptSave(path);
    },
    [attemptSave, clearTimers, recreate],
  );

  const pathRemoved = useCallback(
    (removed: string) => {
      const affected = latest.current.filter((file) => within(file.path, removed));
      if (affected.length === 0) return;

      const closing = new Set<string>();
      for (const file of affected) {
        clearTimers(file.path);
        attempts.current.delete(file.path);
        if (isDirty(file)) {
          patch(file.path, {
            deleted: true,
            saveState: 'idle',
            conflict: undefined,
            message: undefined,
          });
        } else {
          closing.add(file.path);
        }
      }
      if (closing.size === 0) return;

      const current = latest.current;
      const remaining = current.filter((file) => !closing.has(file.path));
      setActivePath((active) => {
        if (active === undefined || !closing.has(active)) return active;
        const index = current.findIndex((file) => file.path === active);
        for (let step = 0; step < current.length; step++) {
          const left = current[index - step];
          if (left && !closing.has(left.path)) return left.path;
          const right = current[index + step];
          if (right && !closing.has(right.path)) return right.path;
        }
        return undefined;
      });
      latest.current = remaining;
      setFiles(remaining);
    },
    [clearTimers, patch],
  );

  const pathMoved = useCallback(
    (from: string, to: string) => {
      const current = latest.current;
      const renamed = new Map<string, string>();
      for (const file of current) {
        if (within(file.path, from)) renamed.set(file.path, `${to}${file.path.slice(from.length)}`);
      }
      if (renamed.size === 0) return;
      const targets = new Set(renamed.values());

      const held = new Set(
        current
          .filter((file) => !renamed.has(file.path) && targets.has(file.path) && isDirty(file))
          .map((file) => file.path),
      );

      const next: OpenFile[] = [];
      for (const file of current) {
        const target = renamed.get(file.path);
        if (target === undefined) {
          if (!targets.has(file.path) || held.has(file.path)) next.push(file);
          continue;
        }
        clearTimers(file.path);
        attempts.current.delete(file.path);
        if (held.has(target)) {
          if (isDirty(file)) next.push({ ...file, deleted: true, saveState: 'idle' });
          continue;
        }
        if (shared.current.delete(file.path)) shared.current.add(target);
        next.push({
          ...file,
          path: target,
          name: baseName(target),
          language: languageOf(target),
          saveState:
            file.saveState === 'saving' || file.saveState === 'pending'
              ? 'pending'
              : file.saveState,
        });
      }

      latest.current = next;
      setFiles(next);
      setActivePath((active) => {
        const target = active === undefined ? undefined : renamed.get(active);
        if (target === undefined) return active;
        if (held.has(target) && next.some((file) => file.path === active)) return active;
        return target;
      });
      for (const file of next) {
        if (file.saveState === 'pending' && targets.has(file.path)) schedule(file.path);
      }
    },
    [clearTimers, schedule],
  );

  const saveActive = useCallback(async () => {
    if (activePath) await save(activePath);
  }, [activePath, save]);

  const keepMine = useCallback(
    async (path: string) => {
      const file = latest.current.find((candidate) => candidate.path === path);
      if (!file?.conflict) return;

      await attemptSave(path, file.conflict.theirVersion);
    },
    [attemptSave],
  );

  const useTheirs = useCallback(
    (path: string) => {
      const file = latest.current.find((candidate) => candidate.path === path);
      if (!file?.conflict) return;

      clearTimers(path);
      patch(path, {
        content: file.conflict.theirContent,
        saved: file.conflict.theirContent,
        version: file.conflict.theirVersion,
        saveState: 'idle',
        conflict: undefined,
        message: undefined,
        revision: file.revision + 1,
      });
    },
    [clearTimers, patch],
  );

  const flush = useCallback(
    async (path: string) => {
      await save(path);

      const deadline = Date.now() + FLUSH_WAIT_MS;
      let file = latest.current.find((candidate) => candidate.path === path);
      while (file?.saveState === 'saving' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, FLUSH_POLL_MS));
        file = latest.current.find((candidate) => candidate.path === path);
      }

      if (!file || file.status !== 'ready' || !isDirty(file)) return;
      throw new Error(unsavedReason(file));
    },
    [save],
  );

  const flushAll = useCallback(async () => {
    const dirty = latest.current.filter(isDirty);
    const results = await Promise.allSettled(dirty.map((file) => flush(file.path)));
    const failed = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed.length === 0) return;
    const first = failed[0]?.reason;
    throw new Error(
      failed.length === 1 && first instanceof Error
        ? first.message
        : `${String(failed.length)} files could not be saved.`,
    );
  }, [flush]);

  const reload = useCallback(
    (path: string) => {
      if (!latest.current.some((file) => file.path === path)) return;
      patch(path, { status: 'loading', message: undefined });
      void load(path);
    },
    [load, patch],
  );

  useEffect(() => {
    const onRestored = (): void => {
      for (const file of latest.current) {
        if (file.status !== 'ready') continue;
        if (file.saveState !== 'retrying' && file.saveState !== 'blocked') continue;
        attempts.current.delete(file.path);
        void saveRef.current(file.path, file.saveState === 'blocked' ? file.version : undefined);
      }
    };
    window.addEventListener(SESSION_RESTORED_EVENT, onRestored);
    return () => window.removeEventListener(SESSION_RESTORED_EVENT, onRestored);
  }, []);

  useRegisterGuard('editor', {
    isDirty: () => latest.current.some(isDirty),
    flush: flushAll,
    describe: () => describeDirty(latest.current.filter(isDirty)),
  });

  useEffect(() => {
    return () => {
      for (const file of latest.current) {
        if (file.status !== 'ready' || file.saveState !== 'pending' || !isDirty(file)) continue;
        if (shared.current.has(file.path)) continue;
        void apiRequest(`/api/projects/${encodeURIComponent(projectId)}/files/content`, {
          method: 'PUT',
          body: { path: file.path, content: file.content, expectedVersion: file.version },
          keepalive: true,
        }).catch(() => {});
      }
    };
  }, [projectId]);

  const active = files.find((file) => file.path === activePath);

  return {
    files,
    activePath,
    active,
    hasUnsaved: files.some(isDirty),
    dirtyCount: files.filter(isDirty).length,
    online,
    open,
    openPath,
    reload,
    close,
    activate: setActivePath,
    change,
    save,
    saveActive,
    flush,
    flushAll,
    keepMine,
    useTheirs,
    pathRemoved,
    pathMoved,
    setShared,
  };
}

function within(candidate: string, path: string): boolean {
  return candidate === path || candidate.startsWith(`${path}/`);
}

const FLUSH_WAIT_MS = 15_000;
const FLUSH_POLL_MS = 50;

export function unsavedReason(file: OpenFile): string {
  if (file.saveState === 'conflict') {
    return `${file.name} changed elsewhere. Choose which version to keep first.`;
  }
  return file.message ?? `${file.name} could not be saved.`;
}

export function describeDirty(dirty: OpenFile[]): string {
  if (dirty.length === 0) return '';
  if (dirty.length === 1) return `${dirty[0]!.name} has unsaved changes`;
  return `${String(dirty.length)} files have unsaved changes`;
}
