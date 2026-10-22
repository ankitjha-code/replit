import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../lib/auth-context.js';
import { UiProvider, clearToasts } from '../../ui/index.js';
import { ProjectSettingsPage } from '../ProjectSettingsPage.js';
import { PROJECT_ID, baseHandlers, json, routeFetch } from './test-helpers.js';

const unavailableGit = {
  initialized: false,
  commits: [],
  hasUncommittedChanges: false,
  pendingChanges: [],
  unavailableReason: 'No object store is configured.',
  branch: 'main',
  branches: [],
};

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

describe('GitPage', () => {
  it('says git is unavailable once, from a single read of the git state', async () => {
    const calls = routeFetch({
      [`GET /api/projects/${PROJECT_ID}/git/remote`]: () => json({ remote: null }),
      [`GET /api/projects/${PROJECT_ID}/git`]: () => json(unavailableGit),
      ...baseHandlers(),
    });
    render(
      <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}/settings/git`]}>
        <AuthProvider>
          <UiProvider>
            <Routes>
              <Route path="/projects/:projectId/settings/*" element={<ProjectSettingsPage />} />
            </Routes>
          </UiProvider>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Git is not available on this installation.')).toBeVisible();
    expect(screen.getAllByText('Git is not available on this installation.')).toHaveLength(1);
    const gitReads = calls.filter((call) => call.endsWith(`/api/projects/${PROJECT_ID}/git`));
    expect(gitReads).toHaveLength(1);
  });
});
