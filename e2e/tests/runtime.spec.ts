import { expect, test } from '@playwright/test';
import { openWorkspace, signOut, signUp, startRuntime, stopRuntime, writeFile } from './helpers.js';

/**
 * Running a project, in a real browser, against a real container backend.
 *
 * Nothing here is stood in for. Pressing Run creates a container on the host
 * and the assertions read the state the server reports about it. The suite is
 * configured with the Docker provider for exactly this reason: "pressing Run
 * starts something" is not a claim a mock can support.
 *
 * The other half of the picture, an installation with no backend at all, is
 * covered by the API integration tests, which use the default provider.
 */

test.describe('running a project', () => {
  test('says the project is not running before anyone starts it', async ({ page }) => {
    await openWorkspace(page);

    // Not "Ready", not a green dot. Nothing has been started. Read from the
    // chip rather than the page, because the console has a status of its own
    // for the application, which is a different thing that is also not running.
    await expect(page.locator('.runtime-chip')).toHaveText('Not running');
  });

  test('asks which language when the project does not say what it is', async ({ page }) => {
    const projectId = await openWorkspace(page);

    // Start is not a dead end on an empty project: it asks, and nothing is
    // created until the question is answered.
    const start = page.getByRole('button', { name: 'Start', exact: true });
    await expect(start).toBeEnabled();
    await expect(start).toHaveAttribute('title', 'Choose what this project runs.');
    await start.click();

    const dialog = page.getByRole('dialog', { name: 'What does this project run?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio', { name: /Node\.js/ })).toBeChecked();
    await expect(dialog.getByRole('button', { name: 'Start with Node.js' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    await expect(page.locator('.runtime-chip')).toHaveText('Not running');
    const body = await (await page.request.get(`/api/projects/${projectId}/runtime`)).json();
    expect(body.runtime).toBeNull();
  });

  test('a manifest arriving enables Start without a reload', async ({ page }) => {
    const projectId = await openWorkspace(page);
    const start = page.getByRole('button', { name: 'Start', exact: true });
    await expect(start).toHaveAttribute('title', 'Choose what this project runs.');

    // Written through the API: the workspace learns of it over the project's
    // own event stream, exactly as it would from a collaborator.
    await writeFile(page, projectId, 'package.json');

    await expect(start).toHaveAttribute('title', /Node\.js 22, from package\.json/);
    await expect(start).toBeEnabled();
  });

  test('reports the runtime a project needs, and the file that says so', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await writeFile(page, projectId, 'package.json');

    const body = await (await page.request.get(`/api/projects/${projectId}/runtime`)).json();
    expect(body.detected.language).toBe('node');
    expect(body.detected.evidence).toBe('package.json');
    expect(body.runtime).toBeNull();
  });

  test('starts a real container when Start is pressed', async ({ page }) => {
    // The static runtime, because its image is the smallest in the catalogue.
    // The image may need pulling the first time this runs on a machine.
    test.setTimeout(300_000);

    const projectId = await openWorkspace(page, 'Runnable');
    await writeFile(page, projectId, 'index.html', '<h1>hello</h1>');

    // The helper waits for the file to be detected before pressing Start, so
    // the press starts the environment rather than asking for a language.
    // It checks the chip, not the page: several surfaces say the word
    // "running" and two of them are statuses of different things.
    await startRuntime(page);

    // The chip is the client's claim. The server's own record is the evidence,
    // and it says a workload exists and is running.
    const state = await (await page.request.get(`/api/projects/${projectId}/runtime`)).json();
    expect(state.runtime.status).toBe('RUNNING');
    expect(state.runtime.language).toBe('static');
    expect(state.runtime.startedAt).not.toBeNull();

    // Stopping really stops it, and leaves the workspace saying so.
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('.runtime-chip')).toHaveText('Stopped', { timeout: 60_000 });

    const after = await (await page.request.get(`/api/projects/${projectId}/runtime`)).json();
    expect(after.runtime.status).toBe('STOPPED');
    expect(after.runtime.stoppedAt).not.toBeNull();
  });

  test('the runtime state survives a reload, because it is on the server', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await writeFile(page, projectId, 'requirements.txt', 'flask\n');

    await page.reload();
    await expect(page.locator('.runtime-chip')).toHaveText('Not running');

    const body = await (await page.request.get(`/api/projects/${projectId}/runtime`)).json();
    expect(body.detected.language).toBe('python');
  });

  test('records the history of what happened to a runtime', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await writeFile(page, projectId, 'index.html', '<h1>x</h1>');

    // Nothing has been started, so there is nothing to report. An empty
    // history is the honest answer, not an invented one.
    const events = await (
      await page.request.get(`/api/projects/${projectId}/runtime/events`)
    ).json();
    expect(events.events).toEqual([]);
  });

  test('keeps another account away from a project runtime', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await stopRuntime(page, projectId);
    await signOut(page);
    await signUp(page);

    // The same answer a missing project gives, so probing tells an intruder
    // nothing about which projects exist.
    expect((await page.request.get(`/api/projects/${projectId}/runtime`)).status()).toBe(404);
    expect(
      (await page.request.post(`/api/projects/${projectId}/runtime/start`, { data: {} })).status(),
    ).toBe(404);
  });

  test('refuses an anonymous caller', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await signOut(page);
    await page.context().clearCookies();

    expect((await page.request.get(`/api/projects/${projectId}/runtime`)).status()).toBe(401);
  });
});
