import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../lib/auth-context.js';
import { UiProvider, clearToasts } from '../../ui/index.js';
import { ProjectSettingsPage } from '../ProjectSettingsPage.js';
import { PROJECT_ID, baseHandlers, json, routeFetch } from './test-helpers.js';

const idleRun = {
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

function renderEnvironment(role = 'OWNER') {
  routeFetch({
    // Before the general runtime key, which it also contains.
    [`GET /api/projects/${PROJECT_ID}/runtime/run`]: () => json(idleRun),
    ...baseHandlers(role),
  });
  return render(
    <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}/settings/environment`]}>
      <AuthProvider>
        <UiProvider>
          <Routes>
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

describe('EnvironmentPage', () => {
  it('lists the run command first and how code reads values last', async () => {
    renderEnvironment();

    const toc = await screen.findByRole('navigation', { name: 'On this page' });
    expect(
      within(toc)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Run command', 'Environment variables', 'Secrets', 'How your code reads these']);

    const run = await screen.findByRole('region', { name: /Run command/ });
    expect(run.closest('#environment-run')).not.toBeNull();
    const code = await screen.findByRole('region', { name: /How your code reads these/ });
    expect(code.closest('#environment-code')).not.toBeNull();
  });

  it('shows the run command to a viewer without letting them change it', async () => {
    renderEnvironment('VIEWER');

    const run = await screen.findByRole('region', { name: /Run command/ });
    expect(await within(run).findByDisplayValue('npm start')).toBeInTheDocument();
  });
});
