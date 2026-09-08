import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Running a project's own application, in a real browser.
 *
 * The whole path with nothing stood in for: a command set in the workspace, a
 * process started inside the project's container, its output carried back over
 * a socket, its exit code reported, and the preview following it. Every
 * assertion reads what the platform actually said, and the program it runs is
 * the platform's own doing rather than a fixture pretending to be one.
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

async function openWorkspace(page: Page, name = 'Run Test'): Promise<string> {
  await signUp(page);
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await expect(page.getByRole('region', { name: 'Files' })).toBeVisible();
  return page.url().split('/projects/')[1]!;
}

async function writeFile(page: Page, projectId: string, path: string, content: string) {
  const response = await page.request.put(`/api/projects/${projectId}/files/content`, {
    data: { path, content, encoding: 'utf8' },
  });
  expect(response.status()).toBe(200);
}

/**
 * The console's own region.
 *
 * Scoped rather than searched for across the page, because the workspace shows
 * two statuses: the container's, in the toolbar, and the application's, here.
 * They use some of the same words for different facts.
 */
function consoleOf(page: Page): Locator {
  return page.getByRole('region', { name: 'Console' });
}

/** A project with a container up, ready to be run in. */
async function startedProject(page: Page, name = 'Run Test'): Promise<string> {
  // The static runtime: its image is the smallest in the catalogue, and the
  // shell inside it can be told to do anything this file needs.
  const projectId = await openWorkspace(page, name);
  await writeFile(page, projectId, 'index.html', '<h1>served-by-the-run</h1>');
  await page.reload();

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.runtime-chip')).toHaveText('Running', { timeout: 280_000 });
  return projectId;
}

/** Sets what the project runs, through the workspace rather than the API. */
async function setCommand(page: Page, command: string): Promise<void> {
  await consoleOf(page).getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Run command').fill(command);
  await consoleOf(page).getByRole('button', { name: 'Save' }).click();
  await expect(consoleOf(page).getByText(command, { exact: true })).toBeVisible();
}

async function stopRuntime(page: Page, projectId: string) {
  await page.request.post(`/api/projects/${projectId}/runtime/stop`, { data: {} });
}

test.describe('running an application', () => {
  test('will not run anything before the project is started', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await writeFile(page, projectId, 'index.html', '<h1>hello</h1>');
    await page.reload();

    // There is a command, because the platform can tell what this project is.
    // There is nowhere to run it, and the button says so rather than failing
    // when it is pressed.
    const run = consoleOf(page).getByRole('button', { name: 'Run' });
    await expect(run).toBeDisabled();
    await expect(run).toHaveAttribute('title', /Start the project/);
    await expect(consoleOf(page).getByText(/Start the project before running it/)).toBeVisible();
  });

  test('says what it would run, and where that came from', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await writeFile(page, projectId, 'index.html', '<h1>hello</h1>');
    await page.reload();

    // A suggestion, labelled as one. The platform guessed this from the files
    // and has not been told it is right.
    await expect(consoleOf(page).getByTitle(/Suggested by the platform/)).toBeVisible();
  });

  test('runs the command it was given and shows what it printed', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await startedProject(page);

    await setCommand(page, "echo OUT''PUT-proof; echo ERR''OR-proof >&2");
    await consoleOf(page).getByRole('button', { name: 'Run' }).click();

    /*
     * Both streams arrive, and they are told apart. A log that cannot
     * distinguish an error from a progress message is a log nobody can read.
     *
     * The markers are split by quoting, so the command shown beside the button
     * contains `OUT''PUT-proof` and only the program's own output contains
     * `OUTPUT-proof`. Without that, the assertion would pass on the console
     * having repeated the command back.
     */
    await expect(page.getByText(/OUTPUT-proof/)).toBeVisible({ timeout: 60_000 });
    const error = page.getByText(/ERROR-proof/);
    await expect(error).toBeVisible({ timeout: 60_000 });
    await expect(error).toHaveClass(/stderr/);

    await stopRuntime(page, projectId);
  });

  test('reports the code a program exited with, rather than calling it done', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await startedProject(page);

    await setCommand(page, 'echo about-to-fail; exit 3');
    await consoleOf(page).getByRole('button', { name: 'Run' }).click();

    await expect(consoleOf(page).getByText('Exited 3', { exact: true })).toBeVisible({
      timeout: 60_000,
    });

    // And the server agrees, which is the record the workspace is reading.
    const state = await (await page.request.get(`/api/projects/${projectId}/runtime/run`)).json();
    expect(state.status).toBe('FAILED');
    expect(state.exitCode).toBe(3);

    await stopRuntime(page, projectId);
  });

  test('keeps the output for whoever opens the console next', async ({ page }) => {
    // The point of holding it on the server: someone who was not watching when
    // a program crashed can still see what it said before it did.
    test.setTimeout(300_000);
    const projectId = await startedProject(page);

    await setCommand(page, "echo PRINTED''-BEFORE-THE-RELOAD");
    await consoleOf(page).getByRole('button', { name: 'Run' }).click();
    await expect(page.getByText(/PRINTED-BEFORE-THE-RELOAD/)).toBeVisible({ timeout: 60_000 });

    await page.reload();

    await expect(page.getByText(/PRINTED-BEFORE-THE-RELOAD/)).toBeVisible({ timeout: 30_000 });

    await stopRuntime(page, projectId);
  });

  test('stops a program that would otherwise keep going', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await startedProject(page);

    await setCommand(page, 'sleep 600');
    await consoleOf(page).getByRole('button', { name: 'Run' }).click();
    await expect(consoleOf(page).getByText('Running', { exact: true })).toBeVisible({
      timeout: 60_000,
    });

    await consoleOf(page).getByRole('button', { name: 'Stop' }).click();
    await expect(consoleOf(page).getByText('Stopped', { exact: true })).toBeVisible({
      timeout: 60_000,
    });

    // Stopped means stopped: the container is still up, and nothing is in it.
    await expect(page.locator('.runtime-chip')).toHaveText('Running');
    const state = await (await page.request.get(`/api/projects/${projectId}/runtime/run`)).json();
    expect(state.status).toBe('EXITED');

    await stopRuntime(page, projectId);
  });

  test('the preview follows the application, with nobody pressing anything', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await startedProject(page, 'Run Preview');

    // Before: a container with nothing serving in it, said plainly.
    await expect(page.getByText(/its application has not been started/)).toBeVisible({
      timeout: 30_000,
    });

    await setCommand(page, 'httpd -f -p 8080 -h /workspace');
    await consoleOf(page).getByRole('button', { name: 'Run' }).click();

    // The preview finds the port on its own, because the application starting
    // is the event that changes what the project serves.
    await expect(page.getByText('port 8080')).toBeVisible({ timeout: 90_000 });

    await stopRuntime(page, projectId);
  });

  test('refuses an output socket opened from another page', async ({ page, request }) => {
    // The same attack the terminal stops, on the socket that carries output: a
    // page the person is visiting opens it, the browser attaches their cookie,
    // and that page is reading their application's log.
    const projectId = await openWorkspace(page);

    const response = await request.get(`/ws/projects/${projectId}/output`, {
      headers: {
        Origin: 'https://evil.example',
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });

    expect(response.status()).toBe(403);
  });
});
