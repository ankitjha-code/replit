import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '@platform/shared';
import { EditorPanel, saveLabel } from './EditorPanel.js';
import { useOpenFiles, type OpenFilesState } from './use-open-files.js';
import { DEBOUNCE_MS } from './save-policy.js';

/**
 * Open tabs when their files are deleted, renamed or moved: from this window's
 * Files panel or from anyone else's, through the project's events.
 */

vi.mock('./CodeEditor.js', () => ({
  default: ({
    path,
    value,
    onChange,
  }: {
    path: string;
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label={`Editing ${path}`}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

const entry = (path: string, version = 1): FileEntry => ({
  path,
  name: path.split('/').pop()!,
  type: 'FILE',
  size: 10,
  isBinary: false,
  version,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

/** A tiny server: what exists, and every request made of it. */
function mockServer(initial: string[]) {
  const existing = new Set(initial);
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      const path =
        method === 'PUT'
          ? String(body?.path)
          : (new URL(String(input), 'http://x').searchParams.get('path') ?? '');
      calls.push({ method, path, body });
      const url = new URL(String(input), 'http://x');
      if (method === 'GET' && url.pathname.endsWith('/files')) {
        return Promise.resolve(
          json({ entries: [...existing].map((name) => entry(name)), totalBytes: 0 }),
        );
      }
      if (method === 'PUT') {
        existing.add(path);
        return Promise.resolve(json({ entry: entry(path, 7) }));
      }
      if (!existing.has(path)) {
        return Promise.resolve(
          json({ error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'r' } }, 404),
        );
      }
      return Promise.resolve(
        json({ entry: entry(path), content: `saved ${path}`, encoding: 'utf8' }),
      );
    }),
  );
  return {
    calls,
    writes: () => calls.filter((call) => call.method === 'PUT'),
    remove: (path: string) => existing.delete(path),
    add: (path: string) => existing.add(path),
  };
}

let state: OpenFilesState;

function Hook(): React.JSX.Element {
  state = useOpenFiles(PROJECT, true);
  return <span>{state.files.length}</span>;
}

async function openAll(paths: string[]): Promise<void> {
  for (const path of paths) act(() => state.openPath(path));
  await waitFor(() => expect(state.files.every((file) => file.status === 'ready')).toBe(true));
}

const file = (path: string) => state.files.find((candidate) => candidate.path === path);

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.localStorage.clear();
});

describe('a deleted path', () => {
  it('closes the clean tabs under a deleted folder and keeps the rest', async () => {
    mockServer(['src/a.js', 'src/lib/b.js', 'keep.js']);
    render(<Hook />);
    await openAll(['keep.js', 'src/a.js', 'src/lib/b.js']);
    expect(state.activePath).toBe('src/lib/b.js');

    act(() => state.pathRemoved('src'));

    expect(state.files.map((open) => open.path)).toEqual(['keep.js']);
    // The editor shows what is left rather than nothing.
    expect(state.activePath).toBe('keep.js');
  });

  it('does not touch a file whose name only starts with the deleted one', async () => {
    mockServer(['src/a.js', 'src-old/a.js']);
    render(<Hook />);
    await openAll(['src/a.js', 'src-old/a.js']);

    act(() => state.pathRemoved('src'));

    expect(state.files.map((open) => open.path)).toEqual(['src-old/a.js']);
  });

  it('keeps a tab with unsaved text open, marked deleted, and saves nothing by itself', async () => {
    const server = mockServer(['a.js']);
    render(<Hook />);
    await openAll(['a.js']);
    act(() => state.change('a.js', 'only copy'));

    act(() => state.pathRemoved('a.js'));
    act(() => state.change('a.js', 'only copy, still typing'));
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 200));

    expect(file('a.js')).toMatchObject({ deleted: true, content: 'only copy, still typing' });
    expect(saveLabel(file('a.js')!, true)).toBe('Deleted');
    // An autosave would have quietly brought the file back.
    expect(server.writes()).toHaveLength(0);
    // Still unsaved work as far as leaving the page is concerned.
    expect(state.hasUnsaved).toBe(true);
  });

  it('puts the file back with its text when asked', async () => {
    const server = mockServer(['a.js']);
    render(<Hook />);
    await openAll(['a.js']);
    act(() => state.change('a.js', 'only copy'));
    server.remove('a.js');
    act(() => state.pathRemoved('a.js'));

    await act(() => state.save('a.js'));

    const write = server.writes()[0];
    expect(write?.body).toMatchObject({ path: 'a.js', content: 'only copy' });
    // Created, not replaced: there is no version to replace.
    expect(write?.body).not.toHaveProperty('expectedVersion');
    expect(file('a.js')).toMatchObject({ deleted: undefined, saved: 'only copy', version: 7 });
    expect(state.hasUnsaved).toBe(false);
  });

  it('does not write over something that has appeared at the path since', async () => {
    const server = mockServer(['a.js']);
    render(<Hook />);
    await openAll(['a.js']);
    act(() => state.change('a.js', 'only copy'));
    act(() => state.pathRemoved('a.js'));

    // Still (or again) on the server: somebody put a file there.
    await act(() => state.save('a.js'));

    expect(server.writes()).toHaveLength(0);
    expect(file('a.js')?.deleted).toBe(true);
    expect(file('a.js')?.message).toMatch(/Something is at a\.js again/);
  });
});

describe('a renamed or moved path', () => {
  it('follows a renamed file, keeping its text and the active tab', async () => {
    mockServer(['a.js', 'b.js']);
    render(<Hook />);
    await openAll(['b.js', 'a.js']);
    act(() => state.change('a.js', 'typed'));

    act(() => state.pathMoved('a.js', 'lib/app.ts'));

    expect(state.files.map((open) => open.path)).toEqual(['b.js', 'lib/app.ts']);
    expect(file('lib/app.ts')).toMatchObject({
      name: 'app.ts',
      language: 'typescript',
      content: 'typed',
    });
    expect(state.activePath).toBe('lib/app.ts');
  });

  it('moves every tab inside a renamed folder', async () => {
    mockServer(['src/a.js', 'src/lib/b.js']);
    render(<Hook />);
    await openAll(['src/a.js', 'src/lib/b.js']);

    act(() => state.pathMoved('src', 'app'));

    expect(state.files.map((open) => open.path)).toEqual(['app/a.js', 'app/lib/b.js']);
    expect(state.activePath).toBe('app/lib/b.js');
  });

  it('saves pending text under the new name', async () => {
    const server = mockServer(['a.js']);
    render(<Hook />);
    await openAll(['a.js']);
    act(() => state.change('a.js', 'typed'));

    act(() => state.pathMoved('a.js', 'b.js'));

    await waitFor(() => expect(server.writes()).toHaveLength(1), { timeout: DEBOUNCE_MS + 1_000 });
    expect(server.writes()[0]?.body).toMatchObject({ path: 'b.js', content: 'typed' });
  });
});

describe('in the editor', () => {
  function Panel(): React.JSX.Element {
    state = useOpenFiles(PROJECT, true);
    return <EditorPanel files={state} role="OWNER" projectId={PROJECT} />;
  }

  it('says the file was deleted and offers to save it again or close', async () => {
    const server = mockServer(['a.js']);
    const user = userEvent.setup();
    render(<Panel />);
    await openAll(['a.js']);
    act(() => state.change('a.js', 'only copy'));
    server.remove('a.js');
    act(() => state.pathRemoved('a.js'));

    const bar = await screen.findByRole('alert');
    expect(bar).toHaveTextContent('a.js was deleted');
    expect(screen.getByText('Deleted')).toBeInTheDocument();

    // Close asks first: the text exists nowhere else.
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(
      await screen.findByRole('dialog', { name: 'Save changes to a.js?' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Save as new file' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(server.writes()[0]?.body).toMatchObject({ path: 'a.js', content: 'only copy' });
  });
});
