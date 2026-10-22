import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../lib/auth-context.js';
import { ProjectSettingsPage } from '../routes/ProjectSettingsPage.js';
import {
  PROJECT_ID,
  baseHandlers,
  json,
  project,
  routeFetch,
} from '../routes/settings/test-helpers.js';
import { UiProvider, clearToasts } from '../ui/index.js';
import { AppHeader } from './AppHeader.js';

function renderSettings(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <UiProvider>
          <AppHeader />
          <Routes>
            <Route path="/" element={<h1>Your projects</h1>} />
            <Route path="/projects/:projectId/settings/*" element={<ProjectSettingsPage />} />
          </Routes>
        </UiProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

describe('AppHeader breadcrumb', () => {
  it('names the project and follows a rename on Settings > General without a reload', async () => {
    routeFetch({
      ...baseHandlers(),
      [`PATCH /api/projects/${PROJECT_ID}`]: () => json({ project: project({ name: 'Renamed' }) }),
    });
    renderSettings(`/projects/${PROJECT_ID}/settings/general`);

    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(await within(crumbs).findByRole('link', { name: 'Hello World' })).toBeVisible();

    const name = await screen.findByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await within(crumbs).findByRole('link', { name: 'Renamed' })).toBeVisible();
    expect(within(crumbs).queryByRole('link', { name: 'Hello World' })).not.toBeInTheDocument();
  });
});
