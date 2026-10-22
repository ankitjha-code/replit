import { expect, test } from '@playwright/test';
import { openWorkspace, signOut, signUp, startRuntime, stopRuntime, writeFile } from './helpers.js';

test.describe('running a project', () => {
  test('says the project is not running before anyone starts it', async ({ page }) => {
    await openWorkspace(page);

    await expect(page.locator('.runtime-chip')).toHaveText('Not running');
  });

  test('asks which language when the project does not say what it is', async ({ page }) => {
    const projectId = await openWorkspace(page);

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
    test.setTimeout(300_000);

    const projectId = await openWorkspace(page, 'Runnable');
    await writeFile(page, projectId, 'index.html', '<h1>hello</h1>');

    await startRuntime(page);

    const state = await (await page.request.get(`/api/projects/${projectId}/runtime`)).json();
    expect(state.runtime.status).toBe('RUNNING');
    expect(state.runtime.language).toBe('static');
    expect(state.runtime.startedAt).not.toBeNull();

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
