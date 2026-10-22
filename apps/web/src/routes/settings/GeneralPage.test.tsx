import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../lib/auth-context.js';
import { UiProvider, clearToasts } from '../../ui/index.js';
import { ProjectSettingsPage } from '../ProjectSettingsPage.js';
import { PROJECT_ID, baseHandlers, json, project, routeFetch } from './test-helpers.js';

function renderGeneral() {
  return render(
    <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}/settings/general`]}>
      <AuthProvider>
        <UiProvider>
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

describe('GeneralPage', () => {
  it('renames the project and the heading follows', async () => {
    let patched: unknown;
    routeFetch({
      ...baseHandlers(),
      [`PATCH /api/projects/${PROJECT_ID}`]: (init) => {
        patched = JSON.parse(String(init?.body));
        return json({ project: project({ name: 'Renamed', description: 'A demo' }) });
      },
    });
    renderGeneral();
    await screen.findByRole('heading', { level: 1, name: 'Hello World' });

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription('Nothing has changed yet');

    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Renamed');
    await userEvent.type(screen.getByLabelText('Description'), 'A demo');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Renamed' })).toBeVisible();
    expect(patched).toEqual({ name: 'Renamed', description: 'A demo' });
    expect((await screen.findByText('Saved')).closest('[role="status"]')).toBeInTheDocument();
  });

  it('asks for a name before sending anything', async () => {
    const calls = routeFetch(baseHandlers());
    renderGeneral();
    await screen.findByRole('heading', { level: 1, name: 'Hello World' });

    await userEvent.clear(screen.getByLabelText('Name'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a name');
    expect(calls.some((call) => call.startsWith('PATCH'))).toBe(false);
  });

  it('shows the facts with a copy for the id and the URL read-only', async () => {
    routeFetch(baseHandlers());
    renderGeneral();
    await screen.findByRole('heading', { level: 1, name: 'Hello World' });

    expect(screen.getByText('Your access').nextElementSibling).toHaveTextContent('Owner');
    expect(screen.getByRole('button', { name: 'Copy project id' })).toBeInTheDocument();
    expect(screen.getByLabelText('Project URL')).toHaveValue('/hello-world');
    expect(screen.getByLabelText('Project URL')).toHaveAttribute('readonly');
  });

  it('deletes only after the name is typed, then leaves for the projects list', async () => {
    const calls = routeFetch({
      ...baseHandlers(),
      [`DELETE /api/projects/${PROJECT_ID}`]: () => new Response(null, { status: 204 }),
    });
    renderGeneral();
    await screen.findByRole('heading', { level: 1, name: 'Hello World' });

    await userEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete Hello World?' });
    expect(screen.getByRole('button', { name: 'Yes, delete Hello World' })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/Type .* to confirm/), 'Hello World');
    const confirm = screen.getByRole('button', { name: 'Yes, delete Hello World' });
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);

    expect(await screen.findByRole('heading', { level: 1, name: 'Your projects' })).toBeVisible();
    expect(calls.some((call) => call === `DELETE /api/projects/${PROJECT_ID}`)).toBe(true);
    expect(dialog).not.toBeInTheDocument();
  });

  it('keeps a failed delete inside the dialog, with a retry', async () => {
    routeFetch({
      ...baseHandlers(),
      [`DELETE /api/projects/${PROJECT_ID}`]: () =>
        json({ error: { code: 'CONFLICT', message: 'Stop the environment first.' } }, 409),
    });
    renderGeneral();
    await screen.findByRole('heading', { level: 1, name: 'Hello World' });

    await userEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    await screen.findByRole('alertdialog');
    await userEvent.type(screen.getByLabelText(/Type .* to confirm/), 'Hello World');
    await userEvent.click(screen.getByRole('button', { name: 'Yes, delete Hello World' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Stop the environment first.');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Retry: Yes, delete Hello World' }),
    ).toBeInTheDocument();
    // The page behind the dialog is intact (hidden from AT while the dialog is
    // open): a failed delete never replaces it.
    expect(screen.getByText('Hello World', { selector: 'h1' })).toBeInTheDocument();
  });

  it('lets an editor rename but not delete, and says who can', async () => {
    routeFetch(baseHandlers('EDITOR'));
    renderGeneral();
    await screen.findByRole('heading', { level: 1, name: 'Hello World' });

    expect(screen.getByLabelText('Name')).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Delete project' })).toBeNull();
    const callout = (
      await screen.findByText(/Only the project owner can delete this project/)
    ).closest('[role="status"]') as HTMLElement;
    await waitFor(() => expect(callout).toHaveTextContent('Ask Grace Hopper'));
  });
});
