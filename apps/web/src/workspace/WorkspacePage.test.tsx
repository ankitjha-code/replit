import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspacePage } from './WorkspacePage.js';

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

/** Nothing has run, because nothing can. */
const noRun = {
  status: 'IDLE',
  command: null,
  configuredCommand: null,
  suggestion: null,
  startedAt: null,
  exitedAt: null,
  exitCode: null,
  message: null,
  blockedReason: 'Start the project before running it.',
};

/** The honest answer from an installation with no execution backend. */
const noRuntime = {
  runtime: null,
  detected: null,
  provider: {
    name: 'none',
    available: false,
    reason: 'This installation has no execution backend configured, so projects cannot be started.',
  },
};

/**
 * Serves the project, an empty file tree, and a runtime state beside it.
 *
 * The explorer and the runtime chip both fetch on their own, so a mock that
 * answered every call with the project payload would put them into their error
 * states and hide what these cases are about.
 */
const mockProject = (body: unknown, status = 200) => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
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
    <MemoryRouter initialEntries={['/projects/018f0000-0000-7000-8000-0000000000aa']}>
      <Routes>
        <Route path="/projects/:projectId" element={<WorkspacePage />} />
        <Route path="/projects/:projectId/settings" element={<h1>Settings page</h1>} />
        <Route path="/" element={<h1>Projects home</h1>} />
      </Routes>
    </MemoryRouter>,
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

  it('lays out the four regions', async () => {
    mockProject({ project: project() });
    renderWorkspace();

    for (const region of ['Files', 'Editor', 'Console', 'Preview']) {
      expect(await screen.findByRole('region', { name: region })).toBeInTheDocument();
    }
  });

  it('says each region is empty rather than imitating it', async () => {
    // A greyed-out editor or an empty file tree would suggest the feature is
    // present and broken.
    mockProject({ project: project() });
    renderWorkspace();

    expect(await screen.findByText('No files yet')).toBeInTheDocument();
    expect(screen.getByText('Nothing open')).toBeInTheDocument();
    // The console opens on the application's output, which has nothing to show
    // and says which of the several reasons applies.
    expect(screen.getByText(/Start the project before running it/)).toBeInTheDocument();
    expect(screen.getByText('Nothing to preview')).toBeInTheDocument();
  });

  it('reports that running is unavailable, not that a runtime is ready', async () => {
    mockProject({ project: project() });
    renderWorkspace();
    expect(await screen.findByText('Running unavailable')).toBeInTheDocument();
  });

  it('offers starting as a control that says why it cannot be used', async () => {
    // Earlier there was no button at all, on the grounds that a disabled one
    // implies execution is nearly there. Now the server states whether it can
    // run anything and why not, so a disabled control carrying that reason
    // tells someone more than an absent one.
    mockProject({ project: project() });
    renderWorkspace();
    await screen.findByText('My Project');

    const run = await screen.findByRole('button', { name: 'Start' });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute('title', expect.stringContaining('no execution backend'));

    // Deployment genuinely has no surface yet, so it still offers none.
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
    // Far more presses than it would take to reach zero.
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

    // Corrupt storage must not stop the workspace rendering.
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

    // Some privacy modes throw on any access. Losing a layout preference is a
    // small cost; losing the workspace would not be.
    expect(await screen.findByRole('region', { name: 'Editor' })).toBeInTheDocument();

    getItem.mockRestore();
    setItem.mockRestore();
  });
});
