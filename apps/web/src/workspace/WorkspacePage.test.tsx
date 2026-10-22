import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../lib/auth-context.js';
import { WorkspacePage } from './WorkspacePage.js';
import { PHONE_QUERY } from './shell/use-phone.js';

vi.mock('./editor/CodeEditor.js', () => ({
  default: ({ path, value }: { path: string; value: string }) => (
    <textarea aria-label={`Editing ${path}`} value={value} readOnly />
  ),
}));

const project = (overrides: Record<string, unknown> = {}) => ({
  id: '018f0000-0000-7000-8000-0000000000aa',
  slug: 'my-project',
  name: 'My Project',
  description: null,
  role: 'OWNER',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const me = {
  id: '018f0000-0000-7000-8000-000000000001',
  email: 'ada@example.test',
  username: 'ada',
  displayName: null,
  emailVerified: true,
  isOperator: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const noRun = {
  status: 'IDLE',
  command: null,
  configuredCommand: null,
  suggestion: null,
  startedAt: null,
  exitedAt: null,
  exitCode: null,
  message: null,
  blockedReason: 'Start the environment before running the app.',
};

const noRuntime = {
  runtime: null,
  detected: null,
  provider: {
    name: 'none',
    available: false,
    reason: 'This installation has no execution backend configured, so projects cannot be started.',
  },
};

const mockProject = (body: unknown, status = 200) => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/me')) {
        return Promise.resolve(json({ user: me }));
      }
      if (url.includes('/files')) {
        return Promise.resolve(json({ entries: [], totalBytes: 0 }));
      }
      if (url.includes('/runtime/run')) {
        return Promise.resolve(json(noRun));
      }
      if (url.includes('/runtime')) {
        return Promise.resolve(json(noRuntime));
      }
      return Promise.resolve(json(body, status));
    }),
  );
};

const renderWorkspace = () =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/projects/018f0000-0000-7000-8000-0000000000aa']}>
        <Routes>
          <Route path="/projects/:projectId" element={<WorkspacePage />} />
          <Route path="/projects/:projectId/settings" element={<h1>Settings page</h1>} />
          <Route path="/" element={<h1>Projects home</h1>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => vi.unstubAllGlobals());

describe('the workspace shell', () => {
  it('names the project it opened', async () => {
    mockProject({ project: project() });
    renderWorkspace();

    expect(await screen.findByText('My Project')).toBeInTheDocument();
    expect(screen.getByText('/my-project')).toBeInTheDocument();
  });

  it('makes the project name the page heading and the tab title', async () => {
    mockProject({ project: project() });
    renderWorkspace();

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('My Project');
    await waitFor(() => expect(document.title).toBe('My Project · Workspace'));
  });

  it('starts keyboard focus at the project heading, so Tab moves on to the toolbar', async () => {
    mockProject({ project: project() });
    renderWorkspace();

    const heading = await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('leaves focus alone when something already holds it on arrival', async () => {
    mockProject({ project: project() });
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    renderWorkspace();

    await screen.findByRole('heading', { level: 1 });
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it('carries the account menu, since the global header is not shown here', async () => {
    mockProject({ project: project() });
    renderWorkspace();

    const trigger = await waitFor(() => {
      const found = document.querySelector('.account-menu__trigger');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(trigger).toHaveTextContent('ada');
  });

  it('keeps Reset layout on screen but says why it has nothing to do', async () => {
    mockProject({ project: project() });
    renderWorkspace();

    const reset = await screen.findByRole('button', { name: 'Reset layout' });
    expect(reset).toBeDisabled();
    expect(reset).toHaveAccessibleDescription('Layout is already the default');
  });

  it('lays out the four regions', async () => {
    mockProject({ project: project() });
    renderWorkspace();

    for (const region of ['Files', 'Editor', 'Console', 'Preview']) {
      expect(await screen.findByRole('region', { name: region })).toBeInTheDocument();
    }
  });

  it('says each region is empty rather than imitating it', async () => {
    mockProject({ project: project() });
    renderWorkspace();

    expect(await screen.findByText('No files yet')).toBeInTheDocument();
    expect(screen.getByText('Nothing open')).toBeInTheDocument();
    expect(screen.getByText(/Start the environment before running the app/)).toBeInTheDocument();
    expect(screen.getByText('Nothing to preview')).toBeInTheDocument();
  });

  it('reports that running is unavailable, not that a runtime is ready', async () => {
    mockProject({ project: project() });
    renderWorkspace();
    expect(await screen.findByText('Running unavailable')).toBeInTheDocument();
  });

  it('offers starting as a control that says why it cannot be used', async () => {
    mockProject({ project: project() });
    renderWorkspace();
    await screen.findByText('My Project');

    const run = await screen.findByRole('button', { name: 'Start' });
    await waitFor(() => {
      expect(run).toBeDisabled();
      expect(run).toHaveAttribute('title', expect.stringContaining('no execution backend'));
    });

    expect(screen.queryByRole('button', { name: /^Deploy$/ })).not.toBeInTheDocument();
  });

  it('shows the same wording for a project that is missing or not yours', async () => {
    mockProject(
      { error: { code: 'NOT_FOUND', message: 'Project not found', requestId: 'r' } },
      404,
    );
    renderWorkspace();

    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
  });

  it('links to settings and back to the project list', async () => {
    mockProject({ project: project() });
    renderWorkspace();

    expect(await screen.findByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/projects/018f0000-0000-7000-8000-0000000000aa/settings',
    );
    expect(screen.getByRole('link', { name: 'All projects' })).toHaveAttribute('href', '/');
  });
});

describe('resizing and collapsing', () => {
  it('exposes a keyboard-operable divider for each resizable panel', async () => {
    mockProject({ project: project() });
    renderWorkspace();

    const separators = await screen.findAllByRole('separator');
    expect(separators).toHaveLength(3);
    for (const separator of separators) {
      expect(separator).toHaveAttribute('tabindex', '0');
    }
  });

  it('widens a panel with the arrow keys', async () => {
    mockProject({ project: project() });
    const user = userEvent.setup();
    renderWorkspace();

    const filesSplitter = await screen.findByRole('separator', { name: 'Resize the files panel' });
    const before = Number(filesSplitter.getAttribute('aria-valuenow'));

    filesSplitter.focus();
    await user.keyboard('{ArrowRight}');

    await waitFor(() =>
      expect(Number(filesSplitter.getAttribute('aria-valuenow'))).toBeGreaterThan(before),
    );
  });

  it('will not shrink a panel below the point of usefulness', async () => {
    mockProject({ project: project() });
    const user = userEvent.setup();
    renderWorkspace();

    const filesSplitter = await screen.findByRole('separator', { name: 'Resize the files panel' });
    filesSplitter.focus();
    await user.keyboard('{ArrowLeft>20/}');

    await waitFor(() =>
      expect(Number(filesSplitter.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(12),
    );
  });

  it('collapses a panel and leaves a way to bring it back', async () => {
    mockProject({ project: project() });
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(await screen.findByRole('button', { name: 'Hide files' }));

    expect(screen.queryByRole('region', { name: 'Files' })).not.toBeInTheDocument();
    const restore = screen.getByRole('button', { name: 'Show files' });

    await user.click(restore);
    expect(screen.getByRole('region', { name: 'Files' })).toBeInTheDocument();
  });

  it('remembers the layout across a remount', async () => {
    mockProject({ project: project() });
    const user = userEvent.setup();
    const first = renderWorkspace();

    await user.click(await screen.findByRole('button', { name: 'Hide console' }));
    first.unmount();

    renderWorkspace();
    expect(await screen.findByRole('button', { name: 'Show console' })).toBeInTheDocument();
  });

  it('puts the layout back with Reset layout', async () => {
    mockProject({ project: project() });
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(await screen.findByRole('button', { name: 'Hide preview' }));
    await user.click(screen.getByRole('button', { name: 'Reset layout' }));

    expect(screen.getByRole('region', { name: 'Preview' })).toBeInTheDocument();
  });

  it('falls back to the default layout when the stored one is unusable', async () => {
    window.localStorage.setItem('workspace.layout.v1', 'not json');
    mockProject({ project: project() });
    renderWorkspace();

    expect(await screen.findByRole('region', { name: 'Editor' })).toBeInTheDocument();
  });

  it('keeps working when storage is unavailable entirely', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    mockProject({ project: project() });
    renderWorkspace();

    expect(await screen.findByRole('region', { name: 'Editor' })).toBeInTheDocument();

    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe('keeping up with the project', () => {
  class FakeSocket {
    static OPEN = 1;
    static instances: FakeSocket[] = [];
    readyState = 0;
    onmessage: ((event: MessageEvent<string>) => void) | null = null;

    constructor(readonly url: string) {
      FakeSocket.instances.push(this);
    }

    send(): void {}
    close(): void {}

    receive(event: unknown): void {
      const message = { type: 'event', at: '2026-01-01T00:00:00.000Z', event };
      this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent<string>);
    }
  }

  const publish = (event: unknown) =>
    FakeSocket.instances.find((socket) => socket.url.includes('/events'))?.receive(event);

  const mockLive = () => {
    const runtime = {
      runtime: null,
      detected: null as unknown,
      provider: { name: 'docker', available: true, reason: null },
    };
    const run = { ...noRun };
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('/auth/me')) {
          return Promise.resolve(json({ user: me }));
        }
        if (url.includes('/files/content')) {
          const path = new URL(url, 'http://x').searchParams.get('path') ?? '';
          return Promise.resolve(
            json({
              entry: {
                path,
                name: path.split('/').pop(),
                type: 'FILE',
                size: 5,
                isBinary: false,
                version: 1,
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
              content: 'hello',
              encoding: 'utf8',
            }),
          );
        }
        if (url.includes('/files')) {
          return Promise.resolve(json({ entries: [], totalBytes: 0 }));
        }
        if (url.includes('/runtime/run')) {
          return Promise.resolve(json(run));
        }
        if (url.includes('/runtime')) {
          return Promise.resolve(json(runtime));
        }
        return Promise.resolve(json({ project: project() }));
      }),
    );
    return { runtime, run, calls };
  };

  const runtimeReads = (calls: string[]) => calls.filter((url) => url.endsWith('/runtime')).length;
  const runReads = (calls: string[]) => calls.filter((url) => url.endsWith('/runtime/run')).length;

  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  it('lets Start be pressed once a file says what the project is, without a reload', async () => {
    const served = mockLive();
    renderWorkspace();

    const start = () => screen.getByRole('button', { name: 'Start' });
    await screen.findByRole('button', { name: 'Start' });
    await waitFor(() => expect(start()).toHaveAttribute('title', 'Choose what this project runs.'));

    served.runtime.detected = {
      language: 'node',
      version: '22',
      image: 'node:22',
      evidence: 'package.json',
    };
    publish({ type: 'file.written', path: 'package.json' });

    await waitFor(() => expect(start()).toHaveAttribute('title', 'Node.js 22, from package.json'));
    expect(start()).toBeEnabled();
  });

  it('asks about the runtime once for a burst of file changes', async () => {
    const served = mockLive();
    renderWorkspace();
    await screen.findByRole('button', { name: 'Start' });
    await waitFor(() => expect(runtimeReads(served.calls)).toBe(1));

    for (const path of ['a.js', 'b.js', 'package.json']) {
      publish({ type: 'file.written', path });
    }

    await waitFor(() => expect(runtimeReads(served.calls)).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(runtimeReads(served.calls)).toBe(2);
  });

  it('closes the tab of a file somebody deleted, and follows one they renamed', async () => {
    window.localStorage.setItem(
      'workspace.tabs.018f0000-0000-7000-8000-0000000000aa',
      JSON.stringify({ paths: ['gone.js', 'old.js'], active: 'old.js' }),
    );
    mockLive();
    renderWorkspace();
    await screen.findByRole('tab', { name: 'gone.js' });
    await screen.findByRole('tab', { name: 'old.js' });

    publish({ type: 'file.removed', path: 'gone.js' });
    await waitFor(() =>
      expect(screen.queryByRole('tab', { name: 'gone.js' })).not.toBeInTheDocument(),
    );

    publish({ type: 'file.moved', from: 'old.js', to: 'src/new.js' });
    expect(await screen.findByRole('tab', { name: 'new.js' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByRole('tab', { name: 'old.js' })).not.toBeInTheDocument();
  });

  it('reads the application state again when the server says it changed', async () => {
    const served = mockLive();
    renderWorkspace();
    await screen.findByText(/Start the environment before running the app/);
    await waitFor(() => expect(runReads(served.calls)).toBe(1));

    publish({ type: 'run.changed', status: 'EXITED', exitCode: 0 });

    await waitFor(() => expect(runReads(served.calls)).toBe(2));
  });
});

describe('the command palette', () => {
  it.each([
    ['Upload files', 'workspace:upload-files'],
    ['Sync files', 'workspace:sync-files'],
  ])('"%s" asks the Files panel through its event', async (label, event) => {
    mockProject({ project: project() });
    const heard = vi.fn();
    document.addEventListener(event, heard);
    const user = userEvent.setup();
    renderWorkspace();
    await screen.findByRole('region', { name: 'Files' });

    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog');
    const entry = within(dialog).getByRole('option', { name: new RegExp(label) });
    if (label === 'Sync files') {
      expect(entry).toHaveAttribute('aria-disabled', 'true');
      expect(entry).toHaveTextContent('The environment is not running');
    } else {
      await user.click(entry);
      expect(heard).toHaveBeenCalledTimes(1);
    }
    document.removeEventListener(event, heard);
  });
});

describe('arriving from a link', () => {
  const PATH = '/projects/018f0000-0000-7000-8000-0000000000aa';

  function LocationProbe(): React.JSX.Element {
    const location = useLocation();
    return <output data-testid="location-state">{JSON.stringify(location.state)}</output>;
  }

  const renderArriving = (state: unknown) =>
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={[{ pathname: PATH, state }]}>
          <Routes>
            <Route
              path="/projects/:projectId"
              element={
                <>
                  <WorkspacePage />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );

  it('opens the file a new starter asked for, once, and forgets the request', async () => {
    mockProject({ project: project() });
    renderArriving({ openFile: 'index.js' });

    const tab = await screen.findByRole('tab', { name: 'index.js' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByTestId('location-state')).toHaveTextContent('null'));
    expect(screen.getAllByRole('tab', { name: 'index.js' })).toHaveLength(1);
  });

  it('brings a collapsed preview back for "Open the preview"', async () => {
    mockProject({ project: project() });
    const user = userEvent.setup();
    const first = renderArriving(null);
    await user.click(await screen.findByRole('button', { name: 'Hide preview' }));
    first.unmount();

    renderArriving({ focus: 'preview' });

    expect(await screen.findByRole('region', { name: 'Preview' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('location-state')).toHaveTextContent('null'));
  });

  it('brings a collapsed console back for "Open the console"', async () => {
    mockProject({ project: project() });
    const user = userEvent.setup();
    const first = renderArriving(null);
    await user.click(await screen.findByRole('button', { name: 'Hide console' }));
    first.unmount();

    renderArriving({ focus: 'console' });

    expect(await screen.findByRole('region', { name: 'Console' })).toBeInTheDocument();
  });

  it('ignores state it does not understand', async () => {
    mockProject({ project: project() });
    renderArriving({ focus: 'somewhere', openFile: 42 });

    expect(await screen.findByText('My Project')).toBeInTheDocument();
    const editor = screen.getByRole('region', { name: 'Editor' });
    expect(within(editor).queryByRole('tab')).not.toBeInTheDocument();
  });

  it('records the project as opened, for the list\'s "Last opened" sort', async () => {
    mockProject({ project: project() });
    renderArriving(null);

    await screen.findByText('My Project');
    const opened = JSON.parse(window.localStorage.getItem('projects.opened.v1') ?? '{}') as Record<
      string,
      string
    >;
    expect(opened['018f0000-0000-7000-8000-0000000000aa']).toEqual(expect.any(String));
  });
});

describe('on a phone', () => {
  const notes = {
    path: 'notes.txt',
    name: 'notes.txt',
    type: 'FILE',
    size: 5,
    isBinary: false,
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === PHONE_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/me')) return Promise.resolve(json({ user: me }));
        if (url.includes('/files/content')) {
          return Promise.resolve(json({ entry: notes, content: 'hello', encoding: 'utf8' }));
        }
        if (url.includes('/files'))
          return Promise.resolve(json({ entries: [notes], totalBytes: 5 }));
        if (url.includes('/runtime/run')) return Promise.resolve(json(noRun));
        if (url.includes('/runtime')) return Promise.resolve(json(noRuntime));
        return Promise.resolve(json({ project: project() }));
      }),
    );
  });

  it('shows the editor when a file is opened from the files panel', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    const panels = await screen.findByRole('tablist', { name: 'Workspace panels' });

    await user.click(within(panels).getByRole('tab', { name: 'Files' }));
    expect(document.getElementById('editor')).not.toBeVisible();
    await user.click(await screen.findByRole('treeitem', { name: /notes\.txt/ }));

    expect(within(panels).getByRole('tab', { name: 'Editor' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('region', { name: 'Editor' })).toBeVisible();
    expect(await screen.findByRole('textbox', { name: 'Editing notes.txt' })).toBeVisible();
  });
});
