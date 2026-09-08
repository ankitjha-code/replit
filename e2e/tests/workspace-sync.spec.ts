import { expect, test, type Page } from '@playwright/test';

/**
 * Work done inside a container, coming back out.
 *
 * The whole point of the feature, checked the only way that proves it: a
 * command typed into the real terminal creates a file inside the real
 * container, and it then appears in the project's own file listing, which is
 * the database.
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

async function openWorkspace(page: Page, name = 'Sync Test'): Promise<string> {
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

/** Creates a runnable project and starts it. */
async function runningProject(page: Page): Promise<string> {
  const projectId = await openWorkspace(page);
  await writeFile(page, projectId, 'index.html', '<h1>hello</h1>');
  await page.reload();

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.runtime-chip')).toHaveText('Running', { timeout: 280_000 });
  await openShell(page);
  return projectId;
}

/**
 * Brings the shell tab forward.
 *
 * The console opens on the application's output, because that is what pressing
 * Run produces. The terminal is the other tab, and nothing is mounted for it
 * until it is chosen.
 */
async function openShell(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Shell' }).click();
}

/**
 * Types a command into the terminal and waits for it to finish.
 *
 * The wait is on a marker the command prints when it is done, not on a prompt
 * character: a prompt is already on screen before anything is typed, so
 * matching one proves nothing and lets the next step run against a command
 * that has not happened yet.
 *
 * The marker is split by quoting, so the terminal's echo of what was typed
 * shows `DO''NE` while only the command's own output shows `DONE`.
 */
async function runCommand(page: Page, command: string): Promise<void> {
  await page.locator('.xterm-screen').first().click();
  await page.keyboard.type(`${command} && echo DO''NE-$?`);
  await page.keyboard.press('Enter');

  await expect
    .poll(async () => (await page.locator('.xterm-rows').first().textContent()) ?? '', {
      timeout: 30_000,
    })
    .toMatch(/DONE-0/);
}

/** The paths the project holds, read from the platform's own listing. */
async function storedPaths(page: Page, projectId: string): Promise<string[]> {
  const response = await page.request.get(`/api/projects/${projectId}/files`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { entries: { path: string }[] };
  return body.entries.map((entry) => entry.path);
}

test.describe('reading a runtime back', () => {
  test('brings a file made by a command into the project', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await runCommand(page, 'echo made > from-the-terminal.txt');
    // Nothing yet: a command changed the container, not the project.
    expect(await storedPaths(page, projectId)).not.toContain('from-the-terminal.txt');

    await page.getByRole('button', { name: 'Read from runtime' }).click();
    await expect(page.getByText(/Read back from the runtime/)).toBeVisible({ timeout: 30_000 });

    expect(await storedPaths(page, projectId)).toContain('from-the-terminal.txt');
    await expect(page.getByRole('treeitem', { name: /from-the-terminal/ })).toBeVisible();
  });

  test('says plainly when nothing changed', async ({ page }) => {
    test.setTimeout(300_000);
    await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Read from runtime' }).click();

    // A real answer, and an invisible one if it were not said.
    await expect(page.getByText('Nothing changed in the runtime.')).toBeVisible({
      timeout: 30_000,
    });
  });

  test('leaves installed dependencies in the container', async ({ page }) => {
    // A real one is a hundred thousand files and would exceed every limit the
    // project has while storing nothing anyone wrote.
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await runCommand(page, 'mkdir -p node_modules/pkg && echo x > node_modules/pkg/i.js');
    await runCommand(page, 'echo mine > kept.txt');

    await page.getByRole('button', { name: 'Read from runtime' }).click();
    await expect(page.getByText(/Read back from the runtime/)).toBeVisible({ timeout: 30_000 });

    const paths = await storedPaths(page, projectId);
    expect(paths).toContain('kept.txt');
    expect(paths.some((path) => path.startsWith('node_modules'))).toBe(false);
  });

  test('offers nothing to read back when nothing is running', async ({ page }) => {
    await openWorkspace(page);

    await expect(page.getByRole('button', { name: 'Read from runtime' })).toHaveCount(0);
  });

  test('reads the files back when the project is stopped', async ({ page }) => {
    // Stopping is the last moment anything inside can be recovered.
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await runCommand(page, 'echo saved > before-stopping.txt');

    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.locator('.runtime-chip')).toHaveText('Stopped', { timeout: 60_000 });

    expect(await storedPaths(page, projectId)).toContain('before-stopping.txt');
  });
});
