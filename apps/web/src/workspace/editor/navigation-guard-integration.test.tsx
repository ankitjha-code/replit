import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { FileEntry } from '@platform/shared';
import { NavigationGuardProvider, useGuardedNavigate } from '../../lib/navigation-guard.js';
import { EditorPanel } from './EditorPanel.js';
import { useOpenFiles } from './use-open-files.js';

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

const entry = (path: string): FileEntry => ({
  path,
  name: path,
  type: 'FILE',
  size: 10,
  isBinary: false,
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi() {
  const writes: Array<{ content?: string; keepalive?: boolean }> = [];
  const spy = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { content?: string };
      writes.push({
        ...body,
        ...(init.keepalive !== undefined ? { keepalive: init.keepalive } : {}),
      });
      return Promise.resolve(json({ entry: { ...entry('a.ts'), version: 2 } }));
    }
    return Promise.resolve(json({ entry: entry('a.ts'), content: 'start', encoding: 'utf8' }));
  });
  vi.stubGlobal('fetch', spy);
  return { writes };
}

function Editor(): React.JSX.Element {
  const files = useOpenFiles(PROJECT, true);
  return (
    <div>
      <button type="button" onClick={() => files.open(entry('a.ts'))}>
        open
      </button>
      <EditorPanel files={files} role="OWNER" projectId={PROJECT} />
    </div>
  );
}

function Nav(): React.JSX.Element {
  const go = useGuardedNavigate();
  return (
    <button type="button" onClick={() => void go('/projects')}>
      Projects
    </button>
  );
}

function Where(): React.JSX.Element {
  return <p>at {useLocation().pathname}</p>;
}

function App(): React.JSX.Element {
  return (
    <MemoryRouter initialEntries={['/workspace']}>
      <NavigationGuardProvider>
        <Nav />
        <Where />
        <Editor />
      </NavigationGuardProvider>
    </MemoryRouter>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

async function openDirty(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'open' }));
  await user.type(await screen.findByLabelText('Editing a.ts'), '!');
  expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
}

describe('leaving the workspace with the editor open', () => {
  it('does not ask when nothing is unsaved', async () => {
    mockApi();
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'open' }));
    await screen.findByLabelText('Editing a.ts');

    await user.click(screen.getByRole('button', { name: 'Projects' }));
    expect(await screen.findByText('at /projects')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asks, names the file, and saves through the editor on "Save and leave"', async () => {
    const api = mockApi();
    const user = userEvent.setup();
    render(<App />);
    await openDirty(user);

    await user.click(screen.getByRole('button', { name: 'Projects' }));
    const dialog = await screen.findByRole('dialog', { name: 'You have unsaved changes' });
    expect(dialog).toHaveTextContent('a.ts has unsaved changes');

    await user.click(screen.getByRole('button', { name: 'Save and leave' }));
    expect(await screen.findByText('at /projects')).toBeInTheDocument();
    expect(api.writes.map((write) => write.content)).toEqual(['start!']);
  });

  it('stays, with the text intact, on Cancel', async () => {
    mockApi();
    const user = userEvent.setup();
    render(<App />);
    await openDirty(user);

    await user.click(screen.getByRole('button', { name: 'Projects' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('at /workspace')).toBeInTheDocument();
    expect(screen.getByLabelText('Editing a.ts')).toHaveValue('start!');
  });

  it('keeps the person here when the save is refused', async () => {
    const api = mockApi();
    const user = userEvent.setup();
    render(<App />);
    await openDirty(user);

    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          json({ error: { code: 'FORBIDDEN', message: 'Not allowed', requestId: 'r' } }, 403),
        ),
      ),
    );

    await user.click(screen.getByRole('button', { name: 'Projects' }));
    await user.click(await screen.findByRole('button', { name: 'Save and leave' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not allowed');
    expect(screen.getByText('at /workspace')).toBeInTheDocument();
    expect(api.writes).toHaveLength(0);
  });

  it('sends the autosave that was already due when the editor unmounts', async () => {
    const api = mockApi();
    const user = userEvent.setup();
    const view = render(<App />);
    await openDirty(user);

    expect(api.writes).toHaveLength(0);
    view.unmount();
    await waitFor(() => expect(api.writes.map((write) => write.content)).toEqual(['start!']));
    expect(api.writes[0]?.keepalive).toBe(true);
  });
});
