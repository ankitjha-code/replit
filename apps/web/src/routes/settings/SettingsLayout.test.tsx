import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../lib/auth-context.js';
import { ProjectSettingsPage } from '../ProjectSettingsPage.js';
import { PROJECT_ID, baseHandlers, json, project, routeFetch } from './test-helpers.js';

const settingsUrl = (page = '') => `/projects/${PROJECT_ID}/settings${page ? `/${page}` : ''}`;

function renderSettings(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<h1>Your projects</h1>} />
          <Route path="/projects/:projectId" element={<h1>Workspace</h1>} />
          <Route path="/projects/:projectId/settings/*" element={<ProjectSettingsPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('ProjectSettingsPage layout', () => {
  it('opens on General and keeps the project name as the h1', async () => {
    routeFetch(baseHandlers());
    renderSettings(settingsUrl());

    expect(await screen.findByRole('heading', { level: 1, name: 'Hello World' })).toBeVisible();
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Name and description' }),
    ).toBeVisible();
    const nav = screen.getByRole('navigation', { name: 'Project settings' });
    await waitFor(() =>
      expect(within(nav).getByRole('link', { name: 'General' })).toHaveAttribute(
        'aria-current',
        'page',
      ),
    );
    expect(document.title).toBe('General · Hello World · Workspace');
  });

  it('lists ten pages in five groups and reaches each by its link', async () => {
    routeFetch(baseHandlers());
    renderSettings(settingsUrl('general'));
    await screen.findByRole('heading', { level: 1, name: 'Hello World' });

    const nav = screen.getByRole('navigation', { name: 'Project settings' });
    for (const group of ['Project', 'Run', 'Ship', 'Safety', 'Observe']) {
      expect(within(nav).getByRole('list', { name: group })).toBeInTheDocument();
    }
    expect(within(nav).getAllByRole('link')).toHaveLength(10);

    await userEvent.click(within(nav).getByRole('link', { name: 'Logs' }));
    expect(within(nav).getByRole('link', { name: 'Logs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: 'Hello World' })).toBeVisible();
    expect(document.title).toBe('Logs · Hello World · Workspace');
  });

  it('shows an editor the owner-only pages with a lock and an explanation, not a blank', async () => {
    routeFetch(baseHandlers('EDITOR'));
    renderSettings(settingsUrl('deploy'));
    await screen.findByRole('heading', { level: 1, name: 'Hello World' });

    const nav = screen.getByRole('navigation', { name: 'Project settings' });
    expect(within(nav).getByRole('link', { name: 'Deploy, owner only' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Database, owner only' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'General' })).toBeInTheDocument();

    const callout = (
      await screen.findByText(/Only the project owner can manage deployments/)
    ).closest('[role="status"]') as HTMLElement;
    expect(await within(callout).findByText(/Ask Grace Hopper/)).toBeInTheDocument();
    expect(within(callout).getByRole('link', { name: 'People' })).toHaveAttribute(
      'href',
      settingsUrl('people'),
    );
  });

  it('gives a page with several sections an in-page nav of anchors', async () => {
    routeFetch(baseHandlers());
    renderSettings(settingsUrl('history'));
    await screen.findByRole('heading', { level: 1, name: 'Hello World' });

    const toc = screen.getByRole('navigation', { name: 'On this page' });
    expect(within(toc).getByRole('link', { name: 'Commits' })).toHaveAttribute(
      'href',
      '#history-commits',
    );
    expect(within(toc).getByRole('link', { name: 'Snapshots' })).toHaveAttribute(
      'href',
      '#history-snapshots',
    );
    expect(document.getElementById('history-snapshots')).toBeInTheDocument();
  });

  it('says not found for a project that does not exist, and for a page that does not', async () => {
    routeFetch({
      ...baseHandlers(),
      [`GET /api/projects/${PROJECT_ID}`]: () =>
        json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404),
    });
    const { unmount } = renderSettings(settingsUrl());
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeVisible();
    unmount();

    routeFetch(baseHandlers());
    renderSettings(settingsUrl('nonsense'));
    await screen.findByRole('heading', { level: 1, name: 'Hello World' });
    expect(screen.getByRole('heading', { level: 1, name: 'Not found' })).toBeVisible();
  });

  it('offers a retry when the project cannot be read', async () => {
    let attempts = 0;
    routeFetch({
      ...baseHandlers(),
      [`GET /api/projects/${PROJECT_ID}`]: () => {
        attempts += 1;
        return attempts === 1
          ? json({ error: { code: 'INTERNAL', message: 'Database is away' } }, 500)
          : json({ project: project() });
      },
    });
    renderSettings(settingsUrl());

    expect(await screen.findByRole('alert')).toHaveTextContent('Database is away');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Hello World' })).toBeVisible();
  });
});
