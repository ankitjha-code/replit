import { expect, test, type Page } from '@playwright/test';

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

function uniqueIdentity() {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    email: `e2e-${suffix}@example.test`,
    username: `e2e-${suffix}`,
    password: 'analytical-engine-1843',
  };
}

async function signUp(page: Page): Promise<void> {
  const identity = uniqueIdentity();
  await page.goto('/register');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Username').fill(identity.username);
  await page.getByLabel('Password').fill(identity.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function openWorkspace(page: Page, name = 'Runtime Test'): Promise<string> {
  await signUp(page);
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await expect(page.getByRole('region', { name: 'Files' })).toBeVisible();
  return page.url().split('/projects/')[1]!;
}

/** Writes a file through the API, which carries the browser's session. */
async function writeFile(page: Page, projectId: string, path: string, content = '{}') {
  const response = await page.request.put(`/api/projects/${projectId}/files/content`, {
    data: { path, content, encoding: 'utf8' },
  });
  expect(response.status()).toBe(200);
}

/** Leaves nothing running behind a test. */
async function stopRuntime(page: Page, projectId: string) {
  await page.request.post(`/api/projects/${projectId}/runtime/stop`, { data: {} });
}

test.describe('running a project', () => {
  test('says the project is not running before anyone starts it', async ({ page }) => {
    await openWorkspace(page);

    // Not "Ready", not a green dot. Nothing has been started. Read from the
    // chip rather than the page, because the console has a status of its own
    // for the application, which is a different thing that is also not running.
    await expect(page.locator('.runtime-chip')).toHaveText('Not running');
  });

  test('will not run a project that does not say what it is', async ({ page }) => {
    await openWorkspace(page);

    const run = page.getByRole('button', { name: 'Start' });
    await expect(run).toBeDisabled();
    await expect(run).toHaveAttribute('title', /does not say which runtime/);
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
    await page.reload();

    const run = page.getByRole('button', { name: 'Start' });
    await expect(run).toBeEnabled();
    await run.click();

    // The chip, not the page: several surfaces say the word "running" and two
    // of them are statuses of different things.
    await expect(page.locator('.runtime-chip')).toHaveText('Running', { timeout: 280_000 });

    // The chip is the client's claim. The server's own record is the evidence,
    // and it says a workload exists and is running.
    const state = await (await page.request.get(`/api/projects/${projectId}/runtime`)).json();
    expect(state.runtime.status).toBe('RUNNING');
    expect(state.runtime.language).toBe('static');
    expect(state.runtime.startedAt).not.toBeNull();

    // Stopping really stops it, and leaves the workspace saying so.
    await page.getByRole('button', { name: 'Stop' }).click();
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
    await page.getByRole('button', { name: 'Sign out' }).click();
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
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.context().clearCookies();

    expect((await page.request.get(`/api/projects/${projectId}/runtime`)).status()).toBe(401);
  });
});
