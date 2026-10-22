import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StarterId } from '../../lib/starter-templates.js';
import { CreateProjectDialog } from './CreateProjectDialog.js';

const PROJECT_ID = '018f0000-0000-7000-8000-0000000000aa';

const project = (overrides: Record<string, unknown> = {}) => ({
  id: PROJECT_ID,
  slug: 'engine',
  name: 'Engine',
  description: null,
  role: 'OWNER',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const runState = {
  status: 'IDLE',
  command: null,
  configuredCommand: 'npm start',
  suggestion: null,
  startedAt: null,
  exitedAt: null,
  exitCode: null,
  message: null,
  blockedReason: null,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const failure = (message: string) =>
  json({ error: { code: 'INTERNAL_ERROR', message, requestId: 'r' } }, 500);

type Handler = (init: RequestInit | undefined) => Response;

function routeFetch(handlers: Record<string, Handler>) {
  const calls: Array<{ key: string; body: unknown }> = [];
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const match = Object.keys(handlers).find((k) => key.endsWith(k));
    if (!match) throw new Error(`unexpected request: ${key}`);
    return Promise.resolve(handlers[match]!(init));
  });
  vi.stubGlobal('fetch', spy);
  return { spy, calls };
}

const writtenPaths = (calls: Array<{ key: string; body: unknown }>) =>
  calls
    .filter((call) => call.key.endsWith('/files/content'))
    .map((call) => (call.body as { path: string }).path);

function Workspace() {
  const { projectId } = useParams();
  return <h1>Workspace {projectId}</h1>;
}

function Harness({ starter, onCreated }: { starter: StarterId; onCreated: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <p>{open ? 'dialog open' : 'dialog closed'}</p>
      <CreateProjectDialog
        open={open}
        onOpenChange={setOpen}
        starter={starter}
        onCreated={onCreated}
      />
    </>
  );
}

const renderDialog = (starter: StarterId, onCreated = vi.fn()) => {
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<Harness starter={starter} onCreated={onCreated} />} />
        <Route path="/projects/:projectId" element={<Workspace />} />
      </Routes>
    </MemoryRouter>,
  );
  return onCreated;
};

const createHandlers = () => ({
  'POST /api/projects': () => json({ project: project() }, 201),
  '/files/content': (init: RequestInit | undefined) => {
    const body = JSON.parse(String(init?.body)) as { path: string };
    return json({ entry: { path: body.path, type: 'file', size: 1, version: 1 } });
  },
  '/run/command': () => json(runState),
});

afterEach(() => vi.unstubAllGlobals());

describe('CreateProjectDialog', () => {
  it('writes a starter in order, saves its run command and opens the workspace', async () => {
    const { calls } = routeFetch(createHandlers());
    const onCreated = renderDialog('node');
    const user = userEvent.setup();

    expect(screen.getByRole('radio', { name: /Node\.js 22/ })).toBeChecked();
    await user.type(screen.getByLabelText('Project name'), 'Engine');
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    expect(
      await screen.findByRole('heading', { name: `Workspace ${PROJECT_ID}` }),
    ).toBeInTheDocument();
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: PROJECT_ID }));
    expect(writtenPaths(calls)).toEqual(['package.json', 'index.js', 'README.md', '.gitignore']);

    const command = calls.find((call) => call.key.endsWith('/run/command'));
    expect(command?.body).toEqual({ command: 'npm start' });
    expect(calls.indexOf(command!)).toBeGreaterThan(
      calls.findIndex(
        (call) =>
          call.key.endsWith('/files/content') &&
          (call.body as { path: string }).path === '.gitignore',
      ),
    );
  });

  it('keeps the project when a file write fails and resumes from that file on retry', async () => {
    let failIndexJs = true;
    const { calls } = routeFetch({
      ...createHandlers(),
      '/files/content': (init) => {
        const body = JSON.parse(String(init?.body)) as { path: string };
        if (body.path === 'index.js' && failIndexJs) return failure('disk full');
        return json({ entry: { path: body.path, type: 'file', size: 1, version: 1 } });
      },
    });
    renderDialog('node');
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Project name'), 'Engine');
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not add index.js. disk full');
    expect(screen.getByRole('button', { name: 'Open anyway' })).toBeInTheDocument();
    expect(writtenPaths(calls)).toEqual(['package.json', 'index.js']);

    failIndexJs = false;
    await user.click(screen.getByRole('button', { name: 'Retry adding files' }));

    expect(
      await screen.findByRole('heading', { name: `Workspace ${PROJECT_ID}` }),
    ).toBeInTheDocument();
    expect(writtenPaths(calls)).toEqual([
      'package.json',
      'index.js',
      'index.js',
      'README.md',
      '.gitignore',
    ]);
    expect(calls.filter((call) => call.key.startsWith('POST /api/projects'))).toHaveLength(1);
  });

  it('opens the project as it is when asked to, after a failed write', async () => {
    routeFetch({
      ...createHandlers(),
      '/files/content': () => failure('disk full'),
    });
    renderDialog('python');
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Project name'), 'Engine');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: 'Open anyway' }));
    expect(
      await screen.findByRole('heading', { name: `Workspace ${PROJECT_ID}` }),
    ).toBeInTheDocument();
  });

  it('leaves a Blank project on the list: no files, no navigation, dialog closed', async () => {
    const { calls } = routeFetch(createHandlers());
    const onCreated = renderDialog('blank');
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Project name'), 'Engine');
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('dialog closed')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Workspace/ })).not.toBeInTheDocument();
    expect(writtenPaths(calls)).toEqual([]);
    expect(calls.some((call) => call.key.endsWith('/run/command'))).toBe(false);
  });

  it('sends the description when one is given', async () => {
    const { calls } = routeFetch(createHandlers());
    renderDialog('blank');
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Project name'), 'Engine');
    await user.type(screen.getByLabelText('Description (optional)'), 'A small server.');
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    await screen.findByText('dialog closed');
    const post = calls.find((call) => call.key.startsWith('POST /api/projects'));
    expect(post?.body).toEqual({ name: 'Engine', description: 'A small server.' });
  });

  it('refuses a reserved URL on blur, before any request', async () => {
    const { calls } = routeFetch(createHandlers());
    renderDialog('blank');
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Project name'), 'Engine');
    await user.click(screen.getByRole('button', { name: 'Choose the URL yourself' }));
    const url = screen.getByLabelText('Project URL');
    await user.clear(url);
    await user.type(url, 'api');
    await user.tab();

    expect(await screen.findByText('That URL is reserved by the platform.')).toBeInTheDocument();
    expect(calls.some((call) => call.key.startsWith('POST'))).toBe(false);
  });

  it('shows where a chosen URL opens as it is typed', async () => {
    routeFetch(createHandlers());
    renderDialog('blank');
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Project name'), 'Engine');
    expect(screen.getByText('Opens at /engine')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Choose the URL yourself' }));
    const url = screen.getByLabelText('Project URL');
    expect(url).toHaveValue('engine');
    await user.clear(url);
    await user.type(url, 'my-engine');
    expect(screen.getByText('Opens at /my-engine')).toBeInTheDocument();
  });
});
