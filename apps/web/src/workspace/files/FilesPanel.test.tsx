import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '@platform/shared';
import { FilesPanel } from './FilesPanel.js';

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

const entry = (path: string, type: 'FILE' | 'DIRECTORY' = 'FILE'): FileEntry => ({
  path,
  name: path.split('/').pop()!,
  type,
  size: type === 'FILE' ? 10 : 0,
  isBinary: false,
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

interface Call {
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
function mockApi(initial: FileEntry[]) {
  let tree = initial;
  const calls: Call[] = [];

  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (method === 'GET' && url.includes('/files') && !url.includes('/search')) {
      return Promise.resolve(
        json({ entries: tree, totalBytes: tree.reduce((t, e) => t + e.size, 0) }),
      );
    }
    if (method === 'PUT' || method === 'POST') {
      return Promise.resolve(json({ entry: entry('placeholder') }, method === 'POST' ? 201 : 200));
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

const renderPanel = (role: 'OWNER' | 'EDITOR' | 'VIEWER' = 'OWNER', runtimeRunning = false) => {
  const onSelect = vi.fn();
  const result = render(
    <FilesPanel
      projectId={PROJECT}
      role={role}
      selected={undefined}
      onSelect={onSelect}
      runtimeRunning={runtimeRunning}
      // Never moves in these cases, so the panel behaves as it did before the
      // event stream existed.
      reloadNonce={0}
    />,
  );
  return { ...result, onSelect };
};

afterEach(() => vi.unstubAllGlobals());

describe('the file explorer', () => {
  it('draws the project tree', async () => {
    mockApi([entry('src', 'DIRECTORY'), entry('src/a.ts'), entry('README.md')]);
    renderPanel();

    expect(await screen.findByRole('tree', { name: 'Project files' })).toBeInTheDocument();
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('hides what is inside a folder until it is opened', async () => {
    mockApi([entry('src', 'DIRECTORY'), entry('src/a.ts')]);
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('src');
    expect(screen.queryByText('a.ts')).not.toBeInTheDocument();

    await user.click(screen.getByText('src'));
    expect(screen.getByText('a.ts')).toBeInTheDocument();
  });

  it('reports expansion to assistive technology', async () => {
    mockApi([entry('src', 'DIRECTORY'), entry('src/a.ts')]);
    const user = userEvent.setup();
    renderPanel();

    const folder = await screen.findByRole('treeitem', { name: /src/ });
    expect(folder).toHaveAttribute('aria-expanded', 'false');

    await user.click(folder);
    expect(screen.getByRole('treeitem', { name: /src/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('reports depth, so nesting is announced', async () => {
    mockApi([entry('src', 'DIRECTORY'), entry('src/a.ts')]);
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByText('src'));
    expect(screen.getByRole('treeitem', { name: /a\.ts/ })).toHaveAttribute('aria-level', '2');
  });

  it('reports a chosen file to the workspace', async () => {
    mockApi([entry('a.ts')]);
    const user = userEvent.setup();
    const { onSelect } = renderPanel();

    await user.click(await screen.findByText('a.ts'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.ts' }));
  });

  it('says the project is empty rather than showing a bare tree', async () => {
    mockApi([]);
    renderPanel();
    expect(await screen.findByText('No files yet')).toBeInTheDocument();
  });

  it('surfaces a failure to load with a way to retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          json({ error: { code: 'INTERNAL_ERROR', message: 'boom', requestId: 'r' } }, 500),
        ),
      ),
    );
    renderPanel();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('keyboard navigation', () => {
  it('keeps only one row in the tab order', async () => {
    // Otherwise tabbing past the explorer takes one press per file.
    mockApi([entry('a.ts'), entry('b.ts'), entry('c.ts')]);
    renderPanel();

    await screen.findByText('a.ts');
    const rows = screen.getAllByRole('treeitem');
    expect(rows.filter((row) => row.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it('moves between rows with the arrow keys', async () => {
    mockApi([entry('a.ts'), entry('b.ts')]);
    const user = userEvent.setup();
    renderPanel();

    const first = await screen.findByRole('treeitem', { name: /a\.ts/ });
    first.focus();
    await user.keyboard('{ArrowDown}');

    expect(screen.getByRole('treeitem', { name: /b\.ts/ })).toHaveFocus();
  });

  it('opens a folder with the right arrow and closes it with the left', async () => {
    mockApi([entry('src', 'DIRECTORY'), entry('src/a.ts')]);
    const user = userEvent.setup();
    renderPanel();

    const folder = await screen.findByRole('treeitem', { name: /src/ });
    folder.focus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByText('a.ts')).toBeInTheDocument();

    screen.getByRole('treeitem', { name: /src/ }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.queryByText('a.ts')).not.toBeInTheDocument();
  });

  it('selects a file with Enter', async () => {
    mockApi([entry('a.ts')]);
    const user = userEvent.setup();
    const { onSelect } = renderPanel();

    (await screen.findByRole('treeitem', { name: /a\.ts/ })).focus();
    await user.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalled();
  });
});

describe('creating', () => {
  it('creates a file at the root', async () => {
    const api = mockApi([]);
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('No files yet');
    await user.click(screen.getByRole('button', { name: 'New file' }));
    await user.type(screen.getByLabelText(/New file name/), 'index.js{Enter}');

    await waitFor(() => {
      const write = api.calls.find((call) => call.method === 'PUT');
      expect(write?.body).toMatchObject({ path: 'index.js', content: '' });
    });
  });

  it('creates a folder', async () => {
    const api = mockApi([]);
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('No files yet');
    await user.click(screen.getByRole('button', { name: 'New folder' }));
    await user.type(screen.getByLabelText(/New folder name/), 'src{Enter}');

    await waitFor(() => {
      const post = api.calls.find((call) => call.url.includes('/directory'));
      expect(post?.body).toMatchObject({ path: 'src' });
    });
  });

  it('reloads the tree rather than guessing what changed', async () => {
    // A local patch would have to reimplement the server's rules and drift.
    const api = mockApi([]);
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('No files yet');
    api.setTree([entry('index.js')]);

    await user.click(screen.getByRole('button', { name: 'New file' }));
    await user.type(screen.getByLabelText(/New file name/), 'index.js{Enter}');

    expect(await screen.findByText('index.js')).toBeInTheDocument();
  });

  it('refuses an invalid name without contacting the server', async () => {
    const api = mockApi([]);
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('No files yet');
    await user.click(screen.getByRole('button', { name: 'New file' }));
    await user.type(screen.getByLabelText(/New file name/), '../escape.txt{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot contain/i);
    expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
  });

  it('does nothing when the name is left empty', async () => {
    const api = mockApi([]);
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('No files yet');
    await user.click(screen.getByRole('button', { name: 'New file' }));
    await user.keyboard('{Enter}');

    expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
  });

  it('shows a rejection from the server beside the tree', async () => {
    const api = mockApi([]);
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('No files yet');
    api.failNext(409, 'A directory already exists at that path');

    await user.click(screen.getByRole('button', { name: 'New file' }));
    await user.type(screen.getByLabelText(/New file name/), 'src{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent('A directory already exists');
  });
});

describe('renaming', () => {
  it('renames on double click', async () => {
    const api = mockApi([entry('old.ts')]);
    const user = userEvent.setup();
    renderPanel();

    await user.dblClick(await screen.findByText('old.ts'));
    const input = screen.getByLabelText('New name');
    await user.clear(input);
    await user.type(input, 'new.ts{Enter}');

    await waitFor(() => {
      const move = api.calls.find((call) => call.url.includes('/move'));
      expect(move?.body).toMatchObject({ from: 'old.ts', to: 'new.ts' });
    });
  });

  it('moves the entry when the new name contains a folder', async () => {
    // The way to move without a pointing device.
    const api = mockApi([entry('a.ts')]);
    const user = userEvent.setup();
    renderPanel();

    await user.dblClick(await screen.findByText('a.ts'));
    const input = screen.getByLabelText('New name');
    await user.clear(input);
    await user.type(input, 'src/a.ts{Enter}');

    await waitFor(() => {
      const move = api.calls.find((call) => call.url.includes('/move'));
      expect(move?.body).toMatchObject({ from: 'a.ts', to: 'src/a.ts' });
    });
  });

  it('starts a rename with F2', async () => {
    mockApi([entry('a.ts')]);
    const user = userEvent.setup();
    renderPanel();

    (await screen.findByRole('treeitem', { name: /a\.ts/ })).focus();
    await user.keyboard('{F2}');

    expect(screen.getByLabelText('New name')).toBeInTheDocument();
  });

  it('abandons a rename on Escape', async () => {
    const api = mockApi([entry('a.ts')]);
    const user = userEvent.setup();
    renderPanel();

    await user.dblClick(await screen.findByText('a.ts'));
    await user.keyboard('{Escape}');

    expect(screen.queryByLabelText('New name')).not.toBeInTheDocument();
    expect(api.calls.filter((call) => call.url.includes('/move'))).toHaveLength(0);
  });

  it('does nothing when the name is unchanged', async () => {
    const api = mockApi([entry('a.ts')]);
    const user = userEvent.setup();
    renderPanel();

    await user.dblClick(await screen.findByText('a.ts'));
    await user.keyboard('{Enter}');

    expect(api.calls.filter((call) => call.url.includes('/move'))).toHaveLength(0);
  });
});

describe('deleting', () => {
  it('asks before deleting, naming what will go', async () => {
    mockApi([entry('src', 'DIRECTORY')]);
    const user = userEvent.setup();
    renderPanel();

    (await screen.findByRole('treeitem', { name: /src/ })).focus();
    await user.keyboard('{Delete}');

    const dialog = screen.getByRole('alertdialog', { name: 'Confirm delete' });
    expect(within(dialog).getByText('src')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('Anything inside it goes too');
  });

  it('deletes once confirmed', async () => {
    const api = mockApi([entry('a.ts')]);
    const user = userEvent.setup();
    renderPanel();

    (await screen.findByRole('treeitem', { name: /a\.ts/ })).focus();
    await user.keyboard('{Delete}');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'DELETE')).toBe(true);
    });
  });

  it('deletes nothing when the confirmation is dismissed', async () => {
    const api = mockApi([entry('a.ts')]);
    const user = userEvent.setup();
    renderPanel();

    (await screen.findByRole('treeitem', { name: /a\.ts/ })).focus();
    await user.keyboard('{Delete}');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  });
});

describe('moving by drag', () => {
  it('moves a file into the folder it is dropped on', async () => {
    const api = mockApi([entry('src', 'DIRECTORY'), entry('a.ts')]);
    renderPanel();

    const file = await screen.findByRole('treeitem', { name: /a\.ts/ });
    const folder = screen.getByRole('treeitem', { name: /src/ });

    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      effectAllowed: '',
      dropEffect: '',
    };

    fireEvent.dragStart(file, { dataTransfer });
    fireEvent.dragOver(folder, { dataTransfer });
    fireEvent.drop(folder, { dataTransfer });

    await waitFor(() => {
      const move = api.calls.find((call) => call.url.includes('/move'));
      expect(move?.body).toMatchObject({ from: 'a.ts', to: 'src/a.ts' });
    });
  });

  it('ignores a folder dropped on itself', async () => {
    const api = mockApi([entry('src', 'DIRECTORY')]);
    renderPanel();

    const folder = await screen.findByRole('treeitem', { name: /src/ });
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      effectAllowed: '',
      dropEffect: '',
    };

    fireEvent.dragStart(folder, { dataTransfer });
    fireEvent.drop(folder, { dataTransfer });

    expect(api.calls.filter((call) => call.url.includes('/move'))).toHaveLength(0);
  });
});

describe('a viewer', () => {
  it('is offered no way to change anything', async () => {
    mockApi([entry('a.ts')]);
    renderPanel('VIEWER');

    await screen.findByText('a.ts');
    expect(screen.queryByRole('button', { name: 'New file' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New folder' })).not.toBeInTheDocument();
  });

  it('cannot start a rename or a delete from the keyboard', async () => {
    const api = mockApi([entry('a.ts')]);
    const user = userEvent.setup();
    renderPanel('VIEWER');

    (await screen.findByRole('treeitem', { name: /a\.ts/ })).focus();
    await user.keyboard('{F2}');
    expect(screen.queryByLabelText('New name')).not.toBeInTheDocument();

    await user.keyboard('{Delete}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  });

  it('can still read the tree', async () => {
    // Hiding the controls is a courtesy, not the enforcement. The server
    // refuses a write from a viewer regardless.
    mockApi([entry('src', 'DIRECTORY'), entry('src/a.ts')]);
    renderPanel('VIEWER');

    expect(await screen.findByRole('tree', { name: 'Project files' })).toBeInTheDocument();
  });

  it('is told why the project looks empty', async () => {
    mockApi([]);
    renderPanel('VIEWER');
    expect(await screen.findByText(/access does not allow adding any/)).toBeInTheDocument();
  });
});

describe('reading files back from a runtime', () => {
  it('offers nothing when nothing is running', async () => {
    // A button that could only refuse would be a worse way of saying the
    // project is not running.
    mockApi([entry('index.js')]);
    renderPanel('OWNER', false);
    await screen.findByRole('treeitem', { name: /index\.js/ });

    expect(screen.queryByRole('button', { name: /Read from runtime/ })).not.toBeInTheDocument();
  });

  it('offers it once a runtime is up', async () => {
    mockApi([entry('index.js')]);
    renderPanel('OWNER', true);
    await screen.findByRole('treeitem', { name: /index\.js/ });

    expect(screen.getByRole('button', { name: 'Read from runtime' })).toBeEnabled();
  });

  it('offers nothing to someone who may not write', async () => {
    mockApi([entry('index.js')]);
    renderPanel('VIEWER', true);
    await screen.findByRole('treeitem', { name: /index\.js/ });

    expect(screen.queryByRole('button', { name: /Read from runtime/ })).not.toBeInTheDocument();
  });
});
