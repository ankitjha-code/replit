import { expect, test, type Page } from '@playwright/test';
import { explorer, openShell, openWorkspace, startedProject } from './helpers.js';

async function runningProject(page: Page): Promise<string> {
  const projectId = await startedProject(page);
  await openShell(page);
  return projectId;
}

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

async function syncFiles(page: Page): Promise<void> {
  await explorer(page).getByRole('button', { name: 'More file actions' }).click();
  await page.getByRole('menuitem', { name: 'Sync files' }).click();
}

const toastText = (page: Page, text: string | RegExp) => page.locator('.ui-toast').getByText(text);

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

    await expect(toastText(page, 'Nothing new in the environment.')).toBeVisible({
      timeout: 30_000,
    });
  });

  test('leaves installed dependencies in the container', async ({ page }) => {
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
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await runCommand(page, 'echo saved > before-stopping.txt');

    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('.runtime-chip')).toHaveText('Stopped', { timeout: 60_000 });

    expect(await storedPaths(page, projectId)).toContain('before-stopping.txt');
  });
});
