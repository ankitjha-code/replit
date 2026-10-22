import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { Toaster } from '../../ui/index.js';
import { NO_WORKSPACE_ACTIONS, WorkspaceActionsContext } from '../shell/workspace-actions.js';
import { FilesPanel } from './FilesPanel.js';
import type { FileEntry, SearchResult } from '@platform/shared';

/*
 * A fetch double for the Files panel tests: serves a tree, echoes writes,
 * answers sync and search, and records every call.
 */

export const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

export const entry = (path: string, type: 'FILE' | 'DIRECTORY' = 'FILE'): FileEntry => ({
  path,
  name: path.split('/').pop()!,
  type,
  size: type === 'FILE' ? 10 : 0,
  isBinary: false,
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

export const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export interface Call {
  method: string;
  url: string;
  body: unknown;
}

/**
 * A fetch double that serves a tree and records every mutation.
 *
 * The tree can be changed between calls, which is how a reload after a
 * mutation is verified: the panel has to ask again rather than patch what it
 * already had.
 */
export function mockApi(initial: FileEntry[]) {
  let tree = initial;
  let sync = { created: 0, updated: 0, deleted: 0 };
  let search: SearchResult[] = [];
  const calls: Call[] = [];

  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (method === 'POST' && url.endsWith('/runtime/sync')) {
      return Promise.resolve(json({ ...sync, unchanged: 0, skipped: [], skippedTruncated: false }));
    }
    if (method === 'GET' && url.includes('/files/search')) {
      return Promise.resolve(json({ results: search, truncated: false }));
    }
    if (method === 'GET' && url.includes('/files/content')) {
      const path = decodeURIComponent(url.split('path=')[1] ?? '');
      return Promise.resolve(json({ entry: entry(path), content: 'hello', encoding: 'utf8' }));
    }
    if (method === 'GET' && url.includes('/files') && !url.includes('/search')) {
      return Promise.resolve(
        json({ entries: tree, totalBytes: tree.reduce((t, e) => t + e.size, 0) }),
      );
    }
    if (method === 'PUT' || method === 'POST') {
      // Echoes the path written, which is what the panel opens after a create.
      const body = init?.body
        ? (JSON.parse(String(init.body)) as { path?: string; to?: string })
        : {};
      return Promise.resolve(
        json(
          { entry: entry(body.path ?? body.to ?? 'placeholder') },
          method === 'POST' ? 201 : 200,
        ),
      );
    }
    if (method === 'DELETE') return Promise.resolve(json(null, 204));

    throw new Error(`unexpected ${method} ${url}`);
  });

  vi.stubGlobal('fetch', spy);
  return {
    calls,
    setTree: (next: FileEntry[]) => {
      tree = next;
    },
    setSync: (next: typeof sync) => {
      sync = next;
    },
    setSearch: (next: typeof search) => {
      search = next;
    },
    /** Replaces the next response for one method with a failure. */
    failNext: (status: number, message: string) => {
      spy.mockImplementationOnce((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          method: init?.method ?? 'GET',
          url: String(input),
          body: undefined,
        });
        return Promise.resolve(
          json({ error: { code: 'CONFLICT', message, requestId: 'r' } }, status),
        );
      });
    },
  };
}

/** The panel inside a workspace context whose `onFilesChanged` is a spy, plus the toast viewport. */
export const renderPanel = (
  role: 'OWNER' | 'EDITOR' | 'VIEWER' = 'OWNER',
  runtimeRunning = false,
  selected: string | undefined = undefined,
) => {
  const onSelect = vi.fn();
  const onFilesChanged = vi.fn();
  const onPathRemoved = vi.fn();
  const onPathMoved = vi.fn();
  const panel = (
    <WorkspaceActionsContext.Provider value={{ ...NO_WORKSPACE_ACTIONS, onFilesChanged }}>
      <FilesPanel
        projectId={PROJECT}
        role={role}
        selected={selected}
        onSelect={onSelect}
        runtimeRunning={runtimeRunning}
        // Never moves in these cases, so the panel behaves as it did before the
        // event stream existed.
        reloadNonce={0}
        onPathRemoved={onPathRemoved}
        onPathMoved={onPathMoved}
      />
      <Toaster />
    </WorkspaceActionsContext.Provider>
  );
  const result = render(panel);
  return { ...result, onSelect, onFilesChanged, onPathRemoved, onPathMoved, panel };
};
