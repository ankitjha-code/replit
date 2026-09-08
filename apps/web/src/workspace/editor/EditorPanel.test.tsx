import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry, ProjectRole } from '@platform/shared';
import { EditorPanel } from './EditorPanel.js';
import { useOpenFiles } from './use-open-files.js';

/**
 * A textarea in place of Monaco.
 *
 * Monaco needs measurement APIs jsdom does not implement, and its own
 * behaviour is not what these cases are about. What is under test is the
 * surrounding model: tabs, dirty state, saving and conflicts. The real editor
 * is exercised in a real browser by the end-to-end suite.
 */
vi.mock('./CodeEditor.js', () => ({
  default: ({
    path,
    value,
    readOnly,
    onChange,
  }: {
    path: string;
    value: string;
    revision: number;
    readOnly: boolean;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label={`Editing ${path}`}
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

const entry = (path: string, overrides: Partial<FileEntry> = {}): FileEntry => ({
  path,
  name: path.split('/').pop()!,
  type: 'FILE',
  size: 10,
  isBinary: false,
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  method: string;
  body: unknown;
}

/** Serves file content and records writes. */
function mockApi(contents: Record<string, { content: string; entry?: Partial<FileEntry> }>) {
  const calls: Call[] = [];
  let writeResult: () => Response = () => json({ entry: entry('x', { version: 2 }) });

  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (method === 'PUT') return Promise.resolve(writeResult());

    const path = decodeURIComponent(new URL(url, 'http://x').searchParams.get('path') ?? '');
    const file = contents[path];
    if (!file) {
      return Promise.resolve(
        json(
          { error: { code: 'NOT_FOUND', message: 'That file does not exist', requestId: 'r' } },
          404,
        ),
      );
    }

    return Promise.resolve(
      json({ entry: entry(path, file.entry), content: file.content, encoding: 'utf8' }),
    );
  });

  vi.stubGlobal('fetch', spy);
  return {
    calls,
    onWrite: (result: () => Response) => {
      writeResult = result;
    },
    /** Changes what a later read of a path returns, as another writer would. */
    setContent: (path: string, file: { content: string; entry?: Partial<FileEntry> }) => {
      contents[path] = file;
    },
  };
}

/** Drives the panel through the same hook the workspace uses. */
function Harness({
  role = 'OWNER',
  openPaths = [],
}: {
  role?: ProjectRole;
  openPaths?: string[];
}): React.JSX.Element {
  const files = useOpenFiles(PROJECT, role !== 'VIEWER');

  return (
    <div>
      {openPaths.map((path) => (
        <button key={path} type="button" onClick={() => files.open(entry(path))}>
          open {path}
        </button>
      ))}
      <EditorPanel files={files} role={role} projectId={PROJECT} />
    </div>
  );
}

const renderPanel = (props: { role?: ProjectRole; openPaths?: string[] } = {}) => {
  window.localStorage.clear();
  return render(<Harness {...props} />);
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('the editor panel', () => {
  it('says nothing is open before a file is chosen', () => {
    mockApi({});
    renderPanel();
    expect(screen.getByText('Nothing open')).toBeInTheDocument();
  });

  it('opens a file and shows its content', async () => {
    mockApi({ 'a.ts': { content: 'const x = 1' } });
    const user = userEvent.setup();
    renderPanel({ openPaths: ['a.ts'] });

    await user.click(screen.getByRole('button', { name: 'open a.ts' }));

    expect(await screen.findByLabelText('Editing a.ts')).toHaveValue('const x = 1');
  });

  it('shows the full path in the status bar', async () => {
    mockApi({ 'src/a.ts': { content: 'x' } });
    const user = userEvent.setup();
    renderPanel({ openPaths: ['src/a.ts'] });

    await user.click(screen.getByRole('button', { name: 'open src/a.ts' }));
    expect(await screen.findByText('src/a.ts')).toBeInTheDocument();
  });

  it('reports a file it cannot open rather than showing an empty editor', async () => {
    mockApi({});
    const user = userEvent.setup();
    renderPanel({ openPaths: ['gone.ts'] });

    await user.click(screen.getByRole('button', { name: 'open gone.ts' }));
    expect(await screen.findByText('That file does not exist')).toBeInTheDocument();
  });

  it('refuses to open a binary file', async () => {
    mockApi({ 'logo.png': { content: 'AAAA', entry: { isBinary: true } } });
    const user = userEvent.setup();
    renderPanel({ openPaths: ['logo.png'] });

    await user.click(screen.getByRole('button', { name: 'open logo.png' }));
    expect(await screen.findByText(/not text, so it cannot be edited/)).toBeInTheDocument();
  });

  it('refuses to open a file too large for the editor', async () => {
    // Monaco becomes unusable rather than slow, and being told beats a frozen tab.
    mockApi({ 'huge.txt': { content: 'x', entry: { size: 10 * 1024 * 1024 } } });
    const user = userEvent.setup();
    renderPanel({ openPaths: ['huge.txt'] });

    await user.click(screen.getByRole('button', { name: 'open huge.txt' }));
    expect(await screen.findByText(/too large to open/)).toBeInTheDocument();
  });
});

describe('tabs', () => {
  const twoFiles = () => mockApi({ 'a.ts': { content: 'A' }, 'b.ts': { content: 'B' } });

  it('opens a tab per file and shows the last one', async () => {
    twoFiles();
    const user = userEvent.setup();
    renderPanel({ openPaths: ['a.ts', 'b.ts'] });

    await user.click(screen.getByRole('button', { name: 'open a.ts' }));
    await user.click(screen.getByRole('button', { name: 'open b.ts' }));

    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(await screen.findByLabelText('Editing b.ts')).toBeInTheDocument();
  });

  it('does not open the same file twice', async () => {
    twoFiles();
    const user = userEvent.setup();
    renderPanel({ openPaths: ['a.ts'] });

    await user.click(screen.getByRole('button', { name: 'open a.ts' }));
    await user.click(screen.getByRole('button', { name: 'open a.ts' }));

    expect(screen.getAllByRole('tab')).toHaveLength(1);
  });

  it('switches between tabs', async () => {
    twoFiles();
    const user = userEvent.setup();
    renderPanel({ openPaths: ['a.ts', 'b.ts'] });

    await user.click(screen.getByRole('button', { name: 'open a.ts' }));
    await user.click(screen.getByRole('button', { name: 'open b.ts' }));
    await user.click(screen.getByRole('tab', { name: /a\.ts/ }));

    expect(await screen.findByLabelText('Editing a.ts')).toBeInTheDocument();
  });

  it('keeps only the selected tab in the tab order', async () => {
    twoFiles();
    const user = userEvent.setup();
    renderPanel({ openPaths: ['a.ts', 'b.ts'] });

    await user.click(screen.getByRole('button', { name: 'open a.ts' }));
    await user.click(screen.getByRole('button', { name: 'open b.ts' }));

    const tabs = screen.getAllByRole('tab');
    expect(tabs.filter((tab) => tab.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it('moves between tabs with the arrow keys', async () => {
    twoFiles();
    const user = userEvent.setup();
    renderPanel({ openPaths: ['a.ts', 'b.ts'] });

    await user.click(screen.getByRole('button', { name: 'open a.ts' }));
    await user.click(screen.getByRole('button', { name: 'open b.ts' }));

    screen.getByRole('tab', { name: /b\.ts/ }).focus();
    await user.keyboard('{ArrowLeft}');

    expect(await screen.findByLabelText('Editing a.ts')).toBeInTheDocument();
  });

  it('closes a tab and falls back to its neighbour', async () => {
    twoFiles();
    const user = userEvent.setup();
    renderPanel({ openPaths: ['a.ts', 'b.ts'] });

    await user.click(screen.getByRole('button', { name: 'open a.ts' }));
    await user.click(screen.getByRole('button', { name: 'open b.ts' }));
    await user.click(screen.getByRole('button', { name: 'Close b.ts' }));

    // Closing should leave the editor showing something, not nothing.
    expect(await screen.findByLabelText('Editing a.ts')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(1);
  });

  it('says nothing is open once the last tab is closed', async () => {
    twoFiles();
    const user = userEvent.setup();
    renderPanel({ openPaths: ['a.ts'] });

    await user.click(screen.getByRole('button', { name: 'open a.ts' }));
    await user.click(screen.getByRole('button', { name: 'Close a.ts' }));

    expect(screen.getByText('Nothing open')).toBeInTheDocument();
  });
});

describe('unsaved changes', () => {
  it('starts saved and becomes unsaved on the first keystroke', async () => {
    mockApi({ 'a.ts': { content: 'start' } });
    const user = userEvent.setup();
    renderPanel({ openPaths: ['a.ts'] });

    await user.click(screen.getByRole('button', { name: 'open a.ts' }));
    await screen.findByLabelText('Editing a.ts');
    expect(screen.getByText('Saved')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Editing a.ts'), '!');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('becomes saved again when the edit is undone', async () => {
    // Dirtiness is a comparison, not a flag, so it self-corrects.
    mockApi({ 'a.ts': { content: 'start' } });
    const user = userEvent.setup();
    renderPanel({ openPaths: ['a.ts'] });

    await user.click(screen.getByRole('button', { name: 'open a.ts' }));
    const editor = await screen.findByLabelText('Editing a.ts');

    await user.type(editor, '!');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    await user.keyboard('{Backspace}');
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('marks the tab of a file with unsaved work', async () => {
    mockApi({ 'a.ts': { content: 'start' } });
    const user = userEvent.setup();
    renderPanel({ openPaths: ['a.ts'] });

    await user.click(screen.getByRole('button', { name: 'open a.ts' }));
    await user.type(await screen.findByLabelText('Editing a.ts'), '!');

    expect(screen.getByRole('button', { name: 'Close a.ts, unsaved' })).toBeInTheDocument();
  });
});

describe('saving', () => {
  it('sends the edited content with the version it is replacing', async () => {
    const api = mockApi({ 'a.ts': { content: 'start', entry: { version: 3 } } });
    const user = userEvent.setup();
    renderPanel({ openPaths: ['a.ts'] });

    await user.click(screen.getByRole('button', { name: 'open a.ts' }));
    await user.type(await screen.findByLabelText('Editing a.ts'), '!');
    await user.click(screen.getByRole('button', { name: 'Save now' }));

    await waitFor(() => {
      const write = api.calls.find((call) => call.method === 'PUT');
      // The version is what turns a blind overwrite into a detectable conflict.
      expect(write?.body).toMatchObject({ path: 'a.ts', content: 'start!', expectedVersion: 3 });
    });
  });

  it('reports the file as saved afterwards', async () => {
    mockApi({ 'a.ts': { content: 'start' } });
    const user = userEvent.setup();
    renderPanel({ openPaths: ['a.ts'] });

    await user.click(screen.getByRole('button', { name: 'open a.ts' }));
    await user.type(await screen.findByLabelText('Editing a.ts'), '!');
    await user.click(screen.getByRole('button', { name: 'Save now' }));

    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('sends one request when Ctrl+S reaches two handlers', async () => {
    // Monaco binds the combination internally and the window handler binds it
    // too. Without a guard the second request carries the version the first is
    // about to consume, and the file conflicts with itself.
    const api = mockApi({ 'a.ts': { content: 'start' } });
    const user = userEvent.setup();
    renderPanel({ openPaths: ['a.ts'] });

    await user.click(screen.getByRole('button', { name: 'open a.ts' }));
    await user.type(await screen.findByLabelText('Editing a.ts'), '!');

    await Promise.all([
      user.keyboard('{Control>}s{/Control}'),
      user.keyboard('{Control>}s{/Control}'),
    ]);

    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
  });

  it('saves with Ctrl+S', async () => {
    const api = mockApi({ 'a.ts': { content: 'start' } });
    const user = userEvent.setup();
    renderPanel({ openPaths: ['a.ts'] });

    await user.click(screen.getByRole('button', { name: 'open a.ts' }));
    await user.type(await screen.findByLabelText('Editing a.ts'), '!');
    await user.keyboard('{Control>}s{/Control}');

    await waitFor(() => expect(api.calls.some((call) => call.method === 'PUT')).toBe(true));
  });

  it('will not save when nothing changed', async () => {
    const api = mockApi({ 'a.ts': { content: 'start' } });
    const user = userEvent.setup();
    renderPanel({ openPaths: ['a.ts'] });

    await user.click(screen.getByRole('button', { name: 'open a.ts' }));
    await screen.findByLabelText('Editing a.ts');

    expect(screen.getByRole('button', { name: 'Save now' })).toBeDisabled();
    await user.keyboard('{Control>}s{/Control}');
    expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
  });

  it('keeps the text when a save is refused', async () => {
    const api = mockApi({ 'a.ts': { content: 'start' } });
    api.onWrite(() =>
      json({ error: { code: 'INTERNAL_ERROR', message: 'boom', requestId: 'r' } }, 500),
    );

    const user = userEvent.setup();
    renderPanel({ openPaths: ['a.ts'] });

    await user.click(screen.getByRole('button', { name: 'open a.ts' }));
    await user.type(await screen.findByLabelText('Editing a.ts'), '!');
    await user.click(screen.getByRole('button', { name: 'Save now' }));

    // Losing the edit would be far worse than a failed request, and a server
    // fault is transient, so it retries rather than giving up.
    expect(await screen.findByText('Could not save. Retrying…')).toBeInTheDocument();
    expect(screen.getByLabelText('Editing a.ts')).toHaveValue('start!');
  });

  it('stops rather than retrying when trying again cannot help', async () => {
    const api = mockApi({ 'a.ts': { content: 'start' } });
    api.onWrite(() =>
      json(
        {
          error: { code: 'PAYLOAD_TOO_LARGE', message: 'That file is too large', requestId: 'r' },
        },
        413,
      ),
    );

    const user = userEvent.setup();
    renderPanel({ openPaths: ['a.ts'] });

    await user.click(screen.getByRole('button', { name: 'open a.ts' }));
    await user.type(await screen.findByLabelText('Editing a.ts'), '!');
    await user.click(screen.getByRole('button', { name: 'Save now' }));

    expect(await screen.findByText('Not saved')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('too large');
    expect(screen.getByLabelText('Editing a.ts')).toHaveValue('start!');
  });
});

describe('conflicts', () => {
  /** Reaches the conflict state, with `theirs` as the server's other version. */
  const reachConflict = async (theirs = 'their version') => {
    const api = mockApi({ 'a.ts': { content: 'start' } });
    const user = userEvent.setup();
    renderPanel({ openPaths: ['a.ts'] });

    // Opened first, so the buffer starts from what was there.
    await user.click(screen.getByRole('button', { name: 'open a.ts' }));
    await screen.findByLabelText('Editing a.ts');

    // Now someone else writes to the same file, in the order it really happens.
    api.setContent('a.ts', { content: theirs, entry: { version: 9 } });
    api.onWrite(() =>
      json(
        {
          error: {
            code: 'CONFLICT',
            message: 'This file changed since you opened it',
            requestId: 'r',
          },
        },
        409,
      ),
    );

    await user.type(screen.getByLabelText('Editing a.ts'), '!');
    await user.click(screen.getByRole('button', { name: 'Save now' }));
    await screen.findByRole('button', { name: 'Keep mine' });

    return { api, user };
  };

  it('presents a conflict as a choice, not a message', async () => {
    // Whichever version this picked for the person, the other would be gone.
    await reachConflict();

    expect(screen.getByRole('alert')).toHaveTextContent('changed elsewhere');
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use theirs' })).toBeInTheDocument();
  });

  it('leaves the buffer untouched while the choice is open', async () => {
    await reachConflict();
    expect(screen.getByLabelText('Editing a.ts')).toHaveValue('start!');
  });

  it('stops autosaving while a conflict is unresolved', async () => {
    // Retrying the same write would only produce the same conflict.
    const { api, user } = await reachConflict();
    const before = api.calls.filter((call) => call.method === 'PUT').length;

    await user.type(screen.getByLabelText('Editing a.ts'), 'more');
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(before);
  });

  it('overwrites against the other version when told to keep mine', async () => {
    const { api, user } = await reachConflict();
    api.onWrite(() => json({ entry: entry('a.ts', { version: 10 }) }));

    await user.click(screen.getByRole('button', { name: 'Keep mine' }));

    await waitFor(() => {
      const writes = api.calls.filter((call) => call.method === 'PUT');
      // Against their version, which is what makes it a deliberate overwrite
      // rather than another conflict.
      expect(writes[writes.length - 1]?.body).toMatchObject({
        content: 'start!',
        expectedVersion: 9,
      });
    });
  });

  it('replaces the buffer when told to use theirs', async () => {
    const { user } = await reachConflict('their version');

    await user.click(screen.getByRole('button', { name: 'Use theirs' }));

    expect(await screen.findByLabelText('Editing a.ts')).toHaveValue('their version');
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('clears the conflict once a choice is made', async () => {
    const { user } = await reachConflict();

    await user.click(screen.getByRole('button', { name: 'Use theirs' }));
    expect(screen.queryByRole('button', { name: 'Keep mine' })).not.toBeInTheDocument();
  });
});

describe('a viewer', () => {
  it('gets a read-only editor and no save control', async () => {
    mockApi({ 'a.ts': { content: 'start' } });
    const user = userEvent.setup();
    renderPanel({ role: 'VIEWER', openPaths: ['a.ts'] });

    await user.click(screen.getByRole('button', { name: 'open a.ts' }));

    expect(await screen.findByLabelText('Editing a.ts')).toHaveAttribute('readonly');
    expect(screen.getByText('Read only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('cannot make a buffer dirty', async () => {
    // So a refused save can never be a surprise later.
    const api = mockApi({ 'a.ts': { content: 'start' } });
    const user = userEvent.setup();
    renderPanel({ role: 'VIEWER', openPaths: ['a.ts'] });

    await user.click(screen.getByRole('button', { name: 'open a.ts' }));
    await screen.findByLabelText('Editing a.ts');
    await user.keyboard('{Control>}s{/Control}');

    expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
  });
});

describe('remembering open files', () => {
  it('reopens what was open last time', async () => {
    mockApi({ 'a.ts': { content: 'A' } });
    const user = userEvent.setup();

    const first = renderPanel({ openPaths: ['a.ts'] });
    await user.click(screen.getByRole('button', { name: 'open a.ts' }));
    await screen.findByLabelText('Editing a.ts');
    first.unmount();

    render(<Harness openPaths={['a.ts']} />);
    expect(await screen.findByRole('tab', { name: /a\.ts/ })).toBeInTheDocument();
  });

  it('starts empty when the stored value is unusable', async () => {
    mockApi({});
    window.localStorage.setItem(`workspace.tabs.${PROJECT}`, 'not json');

    render(<Harness />);
    expect(screen.getByText('Nothing open')).toBeInTheDocument();
  });
});
