import { expect, test, type Page } from '@playwright/test';
import { explorer, openShell, openWorkspace, startedProject } from './helpers.js';

/**
 * Work done inside a container, coming back out.
 *
 * The whole point of the feature, checked the only way that proves it: a
 * command typed into the real terminal creates a file inside the real
 * container, and it then appears in the project's own file listing, which is
 * the database.
 */

/** Creates a runnable project, starts it, and opens its shell. */
async function runningProject(page: Page): Promise<string> {
  const projectId = await startedProject(page);
  await openShell(page);
  return projectId;
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

/** "Sync files" lives in the Files panel's overflow menu, shown while the environment runs. */
async function syncFiles(page: Page): Promise<void> {
  await explorer(page).getByRole('button', { name: 'More file actions' }).click();
  await page.getByRole('menuitem', { name: 'Sync files' }).click();
}

/** The sync result is a toast; scoped so the screen-reader copy of it does not match too. */
const toastText = (page: Page, text: string | RegExp) => page.locator('.ui-toast').getByText(text);

/** The paths the project holds, read from the platform's own listing. */
async function storedPaths(page: Page, projectId: string): Promise<string[]> {
  const response = await page.request.get(`/api/projects/${projectId}/files`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { entries: { path: string }[] };
  return body.entries.map((entry) => entry.path);
}

test.describe('syncing files from the environment', () => {
  test('brings a file made by a command into the project', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await runCommand(page, 'echo made > from-the-terminal.txt');
    // Nothing yet: a command changed the container, not the project.
    expect(await storedPaths(page, projectId)).not.toContain('from-the-terminal.txt');

    await syncFiles(page);
    await expect(toastText(page, /Synced from the environment/)).toBeVisible({ timeout: 30_000 });

    expect(await storedPaths(page, projectId)).toContain('from-the-terminal.txt');
    await expect(page.getByRole('treeitem', { name: /from-the-terminal/ })).toBeVisible();
  });

  test('says plainly when nothing changed', async ({ page }) => {
    test.setTimeout(300_000);
    await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await syncFiles(page);

    // A real answer, and an invisible one if it were not said.
    await expect(toastText(page, 'Nothing new in the environment.')).toBeVisible({
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

    await syncFiles(page);
    await expect(toastText(page, /Synced from the environment/)).toBeVisible({ timeout: 30_000 });

    const paths = await storedPaths(page, projectId);
    expect(paths).toContain('kept.txt');
    expect(paths.some((path) => path.startsWith('node_modules'))).toBe(false);
  });

  test('offers nothing to sync when nothing is running', async ({ page }) => {
    await openWorkspace(page);

    await explorer(page).getByRole('button', { name: 'More file actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Collapse all' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Sync files' })).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('syncs the files when the environment is stopped', async ({ page }) => {
    // Stopping is the last moment anything inside can be recovered.
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await runCommand(page, 'echo saved > before-stopping.txt');

    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('.runtime-chip')).toHaveText('Stopped', { timeout: 60_000 });

    expect(await storedPaths(page, projectId)).toContain('before-stopping.txt');
  });
});
