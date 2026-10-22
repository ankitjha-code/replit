import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../lib/auth-context.js';
import { ProjectsPage } from './ProjectsPage.js';

const publicUser = {
  id: '018f0000-0000-7000-8000-000000000001',
  email: 'ada@example.test',
  username: 'ada',
  displayName: null,
  emailVerified: false,
  isOperator: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

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

const runState = (overrides: Record<string, unknown> = {}) => ({
  status: 'IDLE',
  command: null,
  configuredCommand: null,
  suggestion: null,
  startedAt: null,
  exitedAt: null,
  exitCode: null,
  message: null,
  blockedReason: null,
  ...overrides,
});

function routeFetch(handlers: Record<string, () => Response>) {
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const match = Object.keys(handlers).find((k) => key.endsWith(k));
    if (!match) throw new Error(`unexpected request: ${key}`);
    return Promise.resolve(handlers[match]!());
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const signedIn = () => ({
  'GET /api/auth/me': () => json({ user: publicUser }),
  'GET /api/quotas': () =>
    json({
      quotas: [
        { kind: 'RUNTIMES', used: 1, limit: 3 },
        { kind: 'DEPLOYMENTS', used: 0, limit: 3 },
        { kind: 'BUILDS', used: 0, limit: 2 },
      ],
    }),
  '/runtime/events': () => json({ events: [] }),
  '/run': () => json(runState()),
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<ProjectsPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );

afterEach(() => vi.unstubAllGlobals());

describe('ProjectsPage', () => {
  it('lists the projects the server returns', async () => {
    routeFetch({
      ...signedIn(),
      'GET /api/projects': () =>
        json({ projects: [project(), project({ id: 'b', name: 'Second', slug: 'second' })] }),
    });

    renderPage();
    expect(await screen.findByText('My Project')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('invites a new account to start, rather than showing an empty list', async () => {
    routeFetch({ ...signedIn(), 'GET /api/projects': () => json({ projects: [] }) });

    renderPage();
    expect(await screen.findByText('Nothing here yet')).toBeInTheDocument();
  });

  it('surfaces a failure to load with a way to retry', async () => {
    routeFetch({
      ...signedIn(),
      'GET /api/projects': () =>
        json({ error: { code: 'INTERNAL_ERROR', message: 'boom', requestId: 'r' } }, 500),
    });

    renderPage();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('creates a project and shows it without refetching the list', async () => {
    const spy = routeFetch({
      ...signedIn(),
      'GET /api/projects': () => json({ projects: [] }),
      'POST /api/projects': () => json({ project: project({ name: 'Engine' }) }, 201),
    });

    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Nothing here yet');

    await user.click(screen.getByRole('button', { name: 'Create your first project' }));
    await user.type(screen.getByLabelText('Project name'), 'Engine');
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    expect(await screen.findByText('Engine')).toBeInTheDocument();
    expect(spy.mock.calls.filter(([url]) => String(url).endsWith('/api/projects'))).toHaveLength(2);
  });

  it('previews the URL the server will derive', async () => {
    routeFetch({ ...signedIn(), 'GET /api/projects': () => json({ projects: [] }) });

    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Nothing here yet');

    await user.click(screen.getByRole('button', { name: 'Create your first project' }));
    await user.type(screen.getByLabelText('Project name'), 'Café Résumé');

    expect(await screen.findByText('Opens at /cafe-resume')).toBeInTheDocument();
  });

  it('rejects an empty name before contacting the server', async () => {
    const spy = routeFetch({ ...signedIn(), 'GET /api/projects': () => json({ projects: [] }) });

    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Nothing here yet');

    await user.click(screen.getByRole('button', { name: 'Create your first project' }));
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    expect(await screen.findByText('Enter a name')).toBeInTheDocument();
    expect(spy.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('shows a slug conflict against the URL field', async () => {
    routeFetch({
      ...signedIn(),
      'GET /api/projects': () => json({ projects: [] }),
      'POST /api/projects': () =>
        json(
          {
            error: {
              code: 'CONFLICT',
              message: 'You already have a project with that slug',
              requestId: 'r',
              details: { field: 'slug' },
            },
          },
          409,
        ),
    });

    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Nothing here yet');

    await user.click(screen.getByRole('button', { name: 'Create your first project' }));
    await user.type(screen.getByLabelText('Project name'), 'Engine');
    await user.click(screen.getByRole('button', { name: 'Choose the URL yourself' }));
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    expect(
      await screen.findByText('You already have a project with that slug'),
    ).toBeInTheDocument();
  });

  it('reports the account limit as a form-level message', async () => {
    routeFetch({
      ...signedIn(),
      'GET /api/projects': () => json({ projects: [] }),
      'POST /api/projects': () =>
        json(
          {
            error: {
              code: 'CONFLICT',
              message: 'You have reached the limit of 50 projects',
              requestId: 'r',
              details: { limit: 50 },
            },
          },
          409,
        ),
    });

    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Nothing here yet');

    await user.click(screen.getByRole('button', { name: 'Create your first project' }));
    await user.type(screen.getByLabelText('Project name'), 'Engine');
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('limit of 50 projects');
  });

  it('shows the caller own role on each card', async () => {
    routeFetch({
      ...signedIn(),
      'GET /api/projects': () => json({ projects: [project({ role: 'VIEWER' })] }),
    });

    renderPage();
    expect(await screen.findByText(/Viewer/)).toBeInTheDocument();
  });

  it('links each project to its own page', async () => {
    routeFetch({ ...signedIn(), 'GET /api/projects': () => json({ projects: [project()] }) });

    renderPage();
    const link = await screen.findByRole('link', { name: /My Project/ });
    expect(link).toHaveAttribute('href', '/projects/018f0000-0000-7000-8000-0000000000aa');
  });
});
