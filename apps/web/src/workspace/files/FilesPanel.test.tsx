import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearToasts } from '../../ui/index.js';
import { WORKSPACE_EVENTS } from '../shell/shortcuts.js';
import { PROJECT, entry, json, mockApi, renderPanel } from './test-helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
  // Open folders are remembered per project; each case starts closed.
  localStorage.clear();
  clearToasts();
});

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

  it('tells the workspace what was renamed, so open tabs follow', async () => {
    mockApi([entry('old.ts')]);
    const user = userEvent.setup();
    const { onPathMoved } = renderPanel();

    await user.dblClick(await screen.findByText('old.ts'));
    const input = screen.getByLabelText('New name');
    await user.clear(input);
    await user.type(input, 'new.ts{Enter}');

    await waitFor(() => expect(onPathMoved).toHaveBeenCalledWith('old.ts', 'new.ts'));
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

  it('tells the workspace what was deleted, so its tabs close', async () => {
    mockApi([entry('src', 'DIRECTORY'), entry('src/a.ts')]);
    const user = userEvent.setup();
    const { onPathRemoved } = renderPanel();

    (await screen.findByRole('treeitem', { name: 'src' })).focus();
    await user.keyboard('{Delete}');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(onPathRemoved).toHaveBeenCalledWith('src'));
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

describe('syncing files from the environment', () => {
  const openMore = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'More file actions' }));
    return screen.findByRole('menu');
  };

  it('offers nothing when nothing is running', async () => {
    // A button that could only refuse would be a worse way of saying the
    // environment is not running.
    mockApi([entry('index.js')]);
    const user = userEvent.setup();
    renderPanel('OWNER', false);
    await screen.findByRole('treeitem', { name: /index\.js/ });

    const menu = await openMore(user);
    expect(within(menu).queryByRole('menuitem', { name: /Sync files/ })).not.toBeInTheDocument();
  });

  it('offers it once the environment is up', async () => {
    mockApi([entry('index.js')]);
    const user = userEvent.setup();
    renderPanel('OWNER', true);
    await screen.findByRole('treeitem', { name: /index\.js/ });

    const menu = await openMore(user);
    expect(within(menu).getByRole('menuitem', { name: 'Sync files' })).toBeEnabled();
  });

  it('offers nothing to someone who may not write', async () => {
    mockApi([entry('index.js')]);
    const user = userEvent.setup();
    renderPanel('VIEWER', true);
    await screen.findByRole('treeitem', { name: /index\.js/ });

    const menu = await openMore(user);
    expect(within(menu).queryByRole('menuitem', { name: /Sync files/ })).not.toBeInTheDocument();
  });

  it('says what came back, in a toast', async () => {
    const api = mockApi([entry('index.js')]);
    api.setSync({ created: 2, updated: 1, deleted: 0 });
    const user = userEvent.setup();
    renderPanel('OWNER', true);
    await screen.findByRole('treeitem', { name: /index\.js/ });

    await user.click(within(await openMore(user)).getByRole('menuitem', { name: 'Sync files' }));

    expect(
      await screen.findByText('Synced from the environment: 2 added, 1 updated.'),
    ).toBeInTheDocument();
    expect(api.calls.some((call) => call.url.endsWith('/runtime/sync'))).toBe(true);
  });

  it('says plainly when nothing was new', async () => {
    const api = mockApi([entry('index.js')]);
    api.setSync({ created: 0, updated: 0, deleted: 0 });
    const user = userEvent.setup();
    renderPanel('OWNER', true);
    await screen.findByRole('treeitem', { name: /index\.js/ });

    await user.click(within(await openMore(user)).getByRole('menuitem', { name: 'Sync files' }));

    expect(await screen.findByText('Nothing new in the environment.')).toBeInTheDocument();
  });
});

describe('creating opens and reports', () => {
  it('opens a new file straight away and tells the workspace', async () => {
    mockApi([]);
    const user = userEvent.setup();
    const { onSelect, onFilesChanged } = renderPanel();

    await screen.findByText('No files yet');
    await user.click(screen.getByRole('button', { name: 'New file' }));
    await user.type(screen.getByLabelText(/New file name/), 'main.py{Enter}');

    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: 'main.py' })),
    );
    expect(onFilesChanged).toHaveBeenCalled();
  });

  it('names the folder a new file goes into', async () => {
    mockApi([entry('src', 'DIRECTORY'), entry('src/a.ts')]);
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByText('src'));
    await user.click(screen.getByRole('button', { name: 'New file' }));

    expect(screen.getByLabelText('New file name in src/')).toHaveFocus();
  });

  it('commits a typed name when focus moves away for good', async () => {
    const api = mockApi([]);
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('No files yet');
    await user.click(screen.getByRole('button', { name: 'New file' }));
    await user.type(screen.getByLabelText(/New file name/), 'blurred.js');
    act(() => screen.getByLabelText(/New file name/).blur());

    await waitFor(() =>
      expect(api.calls.find((call) => call.method === 'PUT')?.body).toMatchObject({
        path: 'blurred.js',
      }),
    );
  });

  it('does not commit when focus comes straight back', async () => {
    // A toast or a closing menu can take focus for a moment; that is not "done".
    const api = mockApi([]);
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('No files yet');
    await user.click(screen.getByRole('button', { name: 'New file' }));
    const input = screen.getByLabelText(/New file name/);
    await user.type(input, 'half');
    act(() => {
      input.blur();
      input.focus();
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    expect(screen.getByLabelText(/New file name/)).toHaveValue('half');
  });

  it('cancels an empty name on blur instead of creating anything', async () => {
    const api = mockApi([]);
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('No files yet');
    await user.click(screen.getByRole('button', { name: 'New file' }));
    act(() => screen.getByLabelText(/New file name/).blur());

    await waitFor(() => expect(screen.queryByLabelText(/New file name/)).not.toBeInTheDocument());
    expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
  });

  it('offers a retry when the server refuses', async () => {
    const api = mockApi([]);
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('No files yet');
    api.failNext(409, 'A directory already exists at that path');
    await user.click(screen.getByRole('button', { name: 'New file' }));
    await user.type(screen.getByLabelText(/New file name/), 'src{Enter}');

    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(2));
  });
});

describe('the frame’s commands', () => {
  it('starts a new file from the palette event', async () => {
    mockApi([entry('a.ts')]);
    renderPanel();
    await screen.findByText('a.ts');

    act(() => {
      document.dispatchEvent(new CustomEvent(WORKSPACE_EVENTS.newFile));
    });
    expect(await screen.findByLabelText(/New file name/)).toBeInTheDocument();
  });

  it('starts a new folder from the palette event', async () => {
    mockApi([entry('a.ts')]);
    renderPanel();
    await screen.findByText('a.ts');

    act(() => {
      document.dispatchEvent(new CustomEvent(WORKSPACE_EVENTS.newFolder));
    });
    expect(await screen.findByLabelText(/New folder name/)).toBeInTheDocument();
  });

  it('focuses the search field on Ctrl+Shift+F (the frame’s event)', async () => {
    mockApi([entry('a.ts')]);
    renderPanel();
    await screen.findByText('a.ts');

    act(() => {
      document.dispatchEvent(new CustomEvent(WORKSPACE_EVENTS.searchFiles));
    });
    expect(screen.getByRole('searchbox', { name: 'Search files' })).toHaveFocus();
  });

  it('ignores create events for a viewer', async () => {
    mockApi([entry('a.ts')]);
    renderPanel('VIEWER');
    await screen.findByText('a.ts');

    act(() => {
      document.dispatchEvent(new CustomEvent(WORKSPACE_EVENTS.newFile));
    });
    expect(screen.queryByLabelText(/New file name/)).not.toBeInTheDocument();
  });
});

describe('the tree remembers and stays reachable', () => {
  it('keeps a row in the tab order when the selected file is inside a closed folder', async () => {
    // The old rule tied the tab stop to the selected row only, so a selected
    // file in a collapsed folder left nothing reachable with Tab.
    mockApi([entry('src', 'DIRECTORY'), entry('src/a.ts'), entry('b.ts')]);
    renderPanel('OWNER', false, 'src/a.ts');

    await screen.findByText('src');
    const tabbable = screen
      .getAllByRole('treeitem')
      .filter((row) => row.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAccessibleName('src');
  });

  it('remembers which folders were open', async () => {
    mockApi([entry('src', 'DIRECTORY'), entry('src/a.ts')]);
    const user = userEvent.setup();
    const { unmount, panel } = renderPanel();

    await user.click(await screen.findByText('src'));
    expect(localStorage.getItem(`workspace.tree.${PROJECT}`)).toBe('["src"]');
    unmount();

    render(panel);
    expect(await screen.findByText('a.ts')).toBeInTheDocument();
  });

  it('collapses every folder from the overflow menu', async () => {
    mockApi([entry('src', 'DIRECTORY'), entry('src/a.ts')]);
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByText('src'));
    expect(screen.getByText('a.ts')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'More file actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Collapse all' }));
    expect(screen.queryByText('a.ts')).not.toBeInTheDocument();
  });

  it('marks a row busy while its operation runs, and refuses a second one', async () => {
    let release!: () => void;
    const api = mockApi([entry('old.ts')]);
    const original = (globalThis.fetch as ReturnType<typeof vi.fn>).getMockImplementation()!;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/move')) {
          api.calls.push({ method: 'POST', url: String(input), body: undefined });
          return new Promise<Response>((resolve) => {
            release = () => resolve(json({ entry: entry('new.ts') }));
          });
        }
        return original(input, init);
      },
    );
    const user = userEvent.setup();
    renderPanel();

    await user.dblClick(await screen.findByText('old.ts'));
    const input = screen.getByLabelText('New name');
    await user.clear(input);
    await user.type(input, 'new.ts{Enter}');

    const row = await screen.findByRole('treeitem', { name: 'old.ts' });
    expect(row).toHaveAttribute('aria-busy', 'true');
    // A second rename of the same row cannot start while the first runs.
    row.focus();
    await user.keyboard('{F2}');
    await user.keyboard('again.ts{Enter}');
    expect(api.calls.filter((call) => call.url.includes('/move'))).toHaveLength(1);

    release();
    await waitFor(() =>
      expect(screen.getByRole('treeitem', { name: 'old.ts' })).not.toHaveAttribute('aria-busy'),
    );
  });
});

describe('keyboard reach', () => {
  it('opens the row menu with Shift+F10', async () => {
    mockApi([entry('a.ts')]);
    const user = userEvent.setup();
    renderPanel();

    (await screen.findByRole('treeitem', { name: 'a.ts' })).focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');

    expect(await screen.findByRole('menu', { name: 'Actions for a.ts' })).toBeInTheDocument();
  });

  it('puts focus back on the tree after the focused row is deleted', async () => {
    const api = mockApi([entry('a.ts'), entry('b.ts')]);
    const user = userEvent.setup();
    renderPanel();

    (await screen.findByRole('treeitem', { name: 'a.ts' })).focus();
    await user.keyboard('{Delete}');
    api.setTree([entry('b.ts')]);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('a.ts')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('treeitem', { name: 'b.ts' })).toHaveFocus());
  });
});
