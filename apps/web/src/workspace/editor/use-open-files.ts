import { useCallback, useEffect, useRef, useState } from 'react';
import { baseName, languageOf, type FileEntry } from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import { fetchFileContent, writeFile } from '../../lib/files-api.js';
import { DEBOUNCE_MS, MAX_WAIT_MS, classifyFailure, retryDelay } from './save-policy.js';

/**
 * Largest file the editor will open.
 *
 * Above this Monaco becomes unusable rather than merely slow, and a person is
 * better served by being told than by a frozen tab. The file is still stored
 * and still readable through the API.
 */
export const EDITOR_MAX_BYTES = 512 * 1024;

export type TabStatus = 'loading' | 'ready' | 'error' | 'unopenable';

/**
 * Where a buffer stands with the server.
 *
 * `retrying` and `conflict` are deliberately distinct. One will resolve itself
 * and needs no attention; the other cannot resolve without a decision, and
 * saying so is the only honest thing to show.
 */
export type SaveState = 'idle' | 'pending' | 'saving' | 'retrying' | 'conflict' | 'blocked';

/** What the server holds, when it disagrees with what is on screen. */
export interface Conflict {
  theirContent: string;
  theirVersion: number;
}

export interface OpenFile {
  path: string;
  name: string;
  language: string;
  status: TabStatus;
  /** What the editor shows. Differs from `saved` exactly when unsaved. */
  content: string;
  /** What the server last confirmed. The comparison point for dirtiness. */
  saved: string;
  /** The version the content came from, used to detect a concurrent save. */
  version: number;
  saveState: SaveState;
  /** Bumped whenever the buffer is replaced from the server rather than typed. */
  revision: number;
  /** When the server last confirmed a write, for the status line. */
  savedAt?: number | undefined;
  conflict?: Conflict | undefined;
  /** A failure to load or save, shown on the tab's own surface. */
  message?: string | undefined;
}

export function isDirty(file: OpenFile): boolean {
  return file.status === 'ready' && file.content !== file.saved;
}

export interface OpenFilesState {
  files: OpenFile[];
  activePath: string | undefined;
  active: OpenFile | undefined;
  hasUnsaved: boolean;
  online: boolean;
  open: (entry: FileEntry) => void;
  close: (path: string) => void;
  activate: (path: string) => void;
  change: (path: string, content: string) => void;
  /** Saves now, skipping the debounce. */
  save: (path: string) => Promise<void>;
  saveActive: () => Promise<void>;
  /** Conflict resolution: overwrite the server's copy with this buffer. */
  keepMine: (path: string) => Promise<void>;
  /** Conflict resolution: discard this buffer and take the server's copy. */
  useTheirs: (path: string) => void;
  /**
   * Says whether a file is being saved by a shared session instead of here.
   *
   * While it is, this module stops scheduling writes for that path and stops
   * treating it as dirty. Two savers on one file would take turns conflicting
   * with each other, and the shared session is the one that can see everybody's
   * keystrokes rather than only this window's.
   */
  setShared: (path: string, shared: boolean) => void;
}

/** Remembers which files were open, per project. */
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
    // Storage throws outright in some privacy modes. Reopening no tabs is a
    // small loss; failing to render the workspace would not be.
    return { paths: [] };
  }
}

interface Timers {
  debounce?: ReturnType<typeof setTimeout>;
  /** Fires even if typing never stops, so a long session is never unsaved. */
  ceiling?: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
}

/**
 * The set of files open in the editor, and their saving.
 *
 * Holds two copies of every buffer: what the server last confirmed, and what
 * the editor shows. Dirtiness is the comparison between them rather than a
 * flag, so it cannot drift out of step with the text and it self-corrects when
 * an edit is undone back to the saved state.
 *
 * Nothing here ever discards a buffer. A failed save retries, a conflict waits
 * for a decision, and a rejection that retrying cannot fix stops and says why.
 * Losing typed code is the one outcome this module exists to prevent.
 */
export function useOpenFiles(projectId: string, canWrite: boolean): OpenFilesState {
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | undefined>();
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const restored = useRef(false);

  /**
   * Paths with a save already in flight.
   *
   * Two saves can start in the same tick: Monaco binds Ctrl+S internally and
   * the window handler binds it too, so one keystroke reaches both. Without
   * this the second request carries the version the first is about to consume
   * and the file conflicts with itself.
   */
  const inFlight = useRef(new Set<string>());

  /** Consecutive failed attempts per path, for the backoff. */
  const attempts = useRef(new Map<string, number>());
  const timers = useRef(new Map<string, Timers>());

  /**
   * The current buffers, readable from a callback.
   *
   * Updated synchronously as well as through the render, because a save
   * triggered in the same tick as the last keystroke must see that keystroke,
   * and a render has not happened yet at that point.
   */
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

  // Held in a ref because the scheduler and the saver refer to each other.
  const saveRef = useRef<(path: string, expectedVersion?: number) => Promise<void>>(async () => {});

  /**
   * Arranges for a save once the typing settles.
   *
   * Two timers: one restarted on every keystroke, and one that is not. Without
   * the second, continuous typing defers the save indefinitely and a crash
   * loses everything since the file was opened.
   */
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

  /**
   * Reads what the server actually holds, so a conflict is a choice rather
   * than a message.
   *
   * The version named in the rejection is already stale by the time it
   * arrives, so the current state is fetched instead of assumed.
   */
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
        // The comparison could not be fetched. The buffer is untouched, which
        // is what matters.
        patch(path, {
          saveState: 'blocked',
          message: 'This file changed elsewhere and the other version could not be read.',
        });
      }
    },
    [clearTimers, patch, projectId],
  );

  /**
   * Writes a buffer, and decides what to do when that fails.
   *
   * `expectedVersion` overrides the buffer's own version, which conflict
   * resolution uses to overwrite deliberately.
   */
  const attemptSave = useCallback(
    async (path: string, expectedVersion?: number): Promise<void> => {
      const file = latest.current.find((candidate) => candidate.path === path);
      if (!file || file.status !== 'ready' || !canWrite) return;

      if (file.content === file.saved) {
        if (file.saveState !== 'idle') patch(path, { saveState: 'idle' });
        return;
      }
      // A conflict waits for a decision. Retrying the same write unprompted
      // would only produce the same conflict.
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

        attempts.current.delete(path);
        clearTimers(path);

        const current = latest.current.find((candidate) => candidate.path === path);
        // Edits made while the request was in flight are still unsaved, and
        // must be scheduled rather than reported as saved.
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
    [load],
  );

  const open = useCallback((entry: FileEntry) => openPath(entry.path), [openPath]);

  // Reopen what was open last time, once, after mount.
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
    } catch {
      // See readStored.
    }
  }, [projectId, files, activePath]);

  /*
   * Connectivity. Retrying on a schedule while the network is down wastes
   * attempts and inflates the backoff, so a reconnection triggers an immediate
   * retry of everything that was waiting rather than letting it sit out the
   * remaining delay.
   */
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

  // Every pending timer belongs to this hook; leaving one running after it
  // unmounts would write into a component that is gone.
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
        // Falling to the neighbour rather than to nothing, so closing a tab
        // leaves the editor showing something.
        const index = current.findIndex((file) => file.path === path);
        return remaining[Math.min(index, remaining.length - 1)]?.path;
      });

      latest.current = remaining;
      setFiles(remaining);
    },
    [clearTimers],
  );

  /**
   * Paths whose saving belongs to a shared session rather than to this module.
   *
   * A ref rather than state: it is read by the save scheduler, which runs from
   * timers and callbacks that were built before any render that changed it.
   */
  const shared = useRef(new Set<string>());

  const setShared = useCallback(
    (path: string, on: boolean) => {
      const held = shared.current.has(path);
      if (held === on) return;

      if (on) {
        shared.current.add(path);
        /*
         * Anything already scheduled is dropped, and the buffer is marked as
         * matching the server.
         *
         * Not a lie: the session was seeded from the same file and is now the
         * thing being written back. Leaving it "unsaved" would put a dot on the
         * tab and a warning in the way of closing the window, for a file that is
         * being saved more reliably than it was before.
         */
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
      // A read-only caller cannot make a buffer dirty, so a rejected save can
      // never be a surprise later.
      if (!canWrite) return;
      // The editor is silent while a file is shared, so reaching here means the
      // session has ended and this buffer is this module's responsibility again.
      if (shared.current.has(path)) return;

      const file = latest.current.find((candidate) => candidate.path === path);
      if (!file || file.content === content) return;

      const clean = content === file.saved;
      const waiting = file.saveState === 'conflict' || file.saveState === 'blocked';

      patch(path, {
        content,
        // An edit that returns the buffer to what the server holds resolves
        // the disagreement, so a conflict stops being one.
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

      // A conflict or a blocked save waits for the person, not for a timer.
      if (waiting) return;
      schedule(path);
    },
    [canWrite, clearTimers, patch, schedule],
  );

  const save = useCallback(
    async (path: string) => {
      clearTimers(path);
      await attemptSave(path);
    },
    [attemptSave, clearTimers],
  );

  const saveActive = useCallback(async () => {
    if (activePath) await save(activePath);
  }, [activePath, save]);

  const keepMine = useCallback(
    async (path: string) => {
      const file = latest.current.find((candidate) => candidate.path === path);
      if (!file?.conflict) return;

      // Writing against their version is a deliberate overwrite, which is
      // exactly what was asked for.
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

  const active = files.find((file) => file.path === activePath);

  return {
    files,
    activePath,
    active,
    hasUnsaved: files.some(isDirty),
    online,
    open,
    close,
    activate: setActivePath,
    change,
    save,
    saveActive,
    keepMine,
    useTheirs,
    setShared,
  };
}
