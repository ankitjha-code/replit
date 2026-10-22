import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearToasts } from '../../ui/index.js';
import { fileMenuGroups, type FileMenuActions } from './FileContextMenu.js';
import { copyPathFor, moveTargets } from './file-actions.js';
import { entry, mockApi, renderPanel } from './test-helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  clearToasts();
});

const actions = (): FileMenuActions => ({
  newFile: vi.fn(),
  newFolder: vi.fn(),
  upload: vi.fn(),
  rename: vi.fn(),
  duplicate: vi.fn(),
  move: vi.fn(),
  copyPath: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
});

const labels = (groups: ReturnType<typeof fileMenuGroups>) =>
  groups.map((group) => group.items.map((item) => item.label));

describe('the menu items', () => {
  it('gives a file every action, grouped as the spec lists them', () => {
    expect(labels(fileMenuGroups(entry('src/a.ts'), true, actions()))).toEqual([
      ['New file here', 'New folder here', 'Upload here'],
      ['Rename', 'Duplicate', 'Move to…'],
      ['Copy path', 'Download'],
      ['Delete'],
    ]);
  });

  it('leaves out what a folder cannot do', () => {
    expect(labels(fileMenuGroups(entry('src', 'DIRECTORY'), true, actions()))).toEqual([
      ['New file here', 'New folder here', 'Upload here'],
      ['Rename', 'Move to…'],
      ['Copy path'],
      ['Delete'],
    ]);
  });

  it('creates beside a file and inside a folder', () => {
    const handlers = actions();
    fileMenuGroups(entry('src/a.ts'), true, handlers)[0]!.items[0]!.onSelect!();
    expect(handlers.newFile).toHaveBeenCalledWith('src');

    fileMenuGroups(entry('lib', 'DIRECTORY'), true, handlers)[0]!.items[1]!.onSelect!();
    expect(handlers.newFolder).toHaveBeenCalledWith('lib');
  });

  it('gives a viewer only what reads', () => {
    expect(labels(fileMenuGroups(entry('a.ts'), false, actions()))).toEqual([
      ['Copy path', 'Download'],
    ]);
  });

  it('explains the empty area to a viewer instead of showing nothing', () => {
    const groups = fileMenuGroups(undefined, false, actions());
    expect(groups[0]!.items[0]).toMatchObject({
      disabledReason: 'You have read-only access to this project.',
    });
  });

  it('offers the root actions on the empty area', () => {
    expect(labels(fileMenuGroups(undefined, true, actions()))).toEqual([
      ['New file', 'New folder', 'Upload'],
    ]);
  });
});

describe('the helpers behind the items', () => {
  it('picks a copy name that is not taken', () => {
    const entries = [entry('src/app.js'), entry('src/app copy.js')];
    expect(copyPathFor('src/app.js', entries)).toBe('src/app copy 2.js');
    expect(copyPathFor('.env', [])).toBe('.env copy');
  });

  it('offers only folders a move can go to', () => {
    const entries = [
      entry('src', 'DIRECTORY'),
      entry('src/lib', 'DIRECTORY'),
      entry('docs', 'DIRECTORY'),
    ];
    expect(moveTargets('src', entries)).toEqual(['docs']);
    expect(moveTargets('src/lib/a.ts', entries)).toEqual(['', 'src', 'docs']);
  });
});

describe('the context menu in the panel', () => {
  it('opens on a row with that row’s items and starts a rename', async () => {
    const api = mockApi([entry('a.ts'), entry('b.ts')]);
    const user = userEvent.setup();
    renderPanel();

    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'b.ts' }));
    const menu = await screen.findByRole('menu', { name: 'Actions for b.ts' });
    await user.click(within(menu).getByRole('menuitem', { name: /Rename/ }));

    const input = await screen.findByLabelText('New name');
    await waitFor(() => expect(input).toHaveFocus());
    await user.clear(input);
    await user.type(input, 'c.ts{Enter}');
    await waitFor(() =>
      expect(api.calls.find((call) => call.url.includes('/move'))?.body).toMatchObject({
        from: 'b.ts',
        to: 'c.ts',
      }),
    );
  });

  it('keeps focus in the field an item opened once the menu has gone', async () => {
    mockApi([entry('a.ts')]);
    const user = userEvent.setup();
    renderPanel();

    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'a.ts' }));
    await user.click(await screen.findByRole('menuitem', { name: /Rename/ }));
    const input = await screen.findByLabelText('New name');
    await waitFor(() => expect(input).toHaveFocus());
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(input).toHaveFocus();
  });

  it('opens the new-file field from a row’s overflow menu, focused', async () => {
    mockApi([entry('src', 'DIRECTORY'), entry('src/a.ts')]);
    const user = userEvent.setup();
    renderPanel();

    await screen.findByRole('treeitem', { name: 'src' });
    await user.click(screen.getByRole('button', { name: 'Actions for src' }));
    await user.click(await screen.findByRole('menuitem', { name: 'New file here' }));
    const input = await screen.findByLabelText(/New file name/);
    await waitFor(() => expect(input).toHaveFocus());
  });

  it('opens on the empty area with the root actions', async () => {
    mockApi([]);
    renderPanel();

    fireEvent.contextMenu(await screen.findByText('No files yet'));
    const menu = await screen.findByRole('menu', { name: 'File actions' });
    expect(within(menu).getByRole('menuitem', { name: 'New file' })).toBeInTheDocument();
  });

  it('offers the same items from the row’s overflow button, for touch', async () => {
    mockApi([entry('a.ts')]);
    const user = userEvent.setup();
    renderPanel();

    await screen.findByRole('treeitem', { name: 'a.ts' });
    await user.click(screen.getByRole('button', { name: 'Actions for a.ts' }));
    const menu = await screen.findByRole('menu', { name: 'Actions for a.ts' });
    expect(within(menu).getByRole('menuitem', { name: /Delete/ })).toBeInTheDocument();
  });

  it('duplicates a file next to itself', async () => {
    const api = mockApi([entry('a.ts')]);
    const user = userEvent.setup();
    renderPanel();

    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'a.ts' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));

    await waitFor(() =>
      expect(api.calls.find((call) => call.method === 'PUT')?.body).toMatchObject({
        path: 'a copy.ts',
        content: 'hello',
        encoding: 'utf8',
      }),
    );
  });

  it('moves into a folder chosen from the list', async () => {
    const api = mockApi([entry('lib', 'DIRECTORY'), entry('a.ts')]);
    const user = userEvent.setup();
    renderPanel();

    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'a.ts' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move a.ts' });
    await user.click(within(dialog).getByRole('button', { name: 'lib/' }));

    await waitFor(() =>
      expect(api.calls.find((call) => call.url.includes('/move'))?.body).toMatchObject({
        from: 'a.ts',
        to: 'lib/a.ts',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('asks before deleting from the menu', async () => {
    mockApi([entry('a.ts')]);
    const user = userEvent.setup();
    renderPanel();

    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'a.ts' }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm delete' });
    expect(dialog).toHaveTextContent('Delete a.ts? This cannot be undone.');
  });

  it('copies a path and says so', async () => {
    mockApi([entry('src', 'DIRECTORY')]);
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPanel();

    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'src' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Copy path' }));

    expect(await screen.findByText('Copied src')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith('src');
  });
});
