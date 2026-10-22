import { expect, test, type Page } from '@playwright/test';
import {
  openShell,
  openWorkspace,
  signOut,
  signUp,
  startedProject,
  stopRuntime,
} from './helpers.js';

const MARKER = 'served-from-the-container';

async function runningProject(page: Page): Promise<string> {
  return startedProject(page, { marker: MARKER });
}

async function serveFromTerminal(page: Page): Promise<void> {
  await openShell(page);
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.locator('.xterm-rows').first().textContent(), { timeout: 30_000 })
    .toMatch(/[#$]/);
  await page.locator('.xterm-screen').first().click();
  await page.keyboard.type('busybox httpd -p 8000 -h /workspace');
  await page.keyboard.press('Enter');
}

test.describe('the preview', () => {
  test('says there is nothing to preview before the project is started', async ({ page }) => {
    await openWorkspace(page);

    await expect(page.getByText('Nothing to preview')).toBeVisible();
    await expect(page.locator('iframe[title="Project preview"]')).toHaveCount(0);
  });

  test('points at Start rather than offering a second one', async ({ page }) => {
    await openWorkspace(page);
    await expect(page.locator('.runtime-chip')).not.toHaveText('Checking…', { timeout: 30_000 });
    const preview = page.getByRole('region', { name: 'Preview' });

    await expect(preview.getByText(/Start the environment, then run the app/)).toBeVisible();
    await preview.getByRole('button', { name: 'Show me', exact: true }).click();

    await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeFocused();
    await expect(preview.getByRole('button', { name: /start/i })).toHaveCount(0);
  });

  test('says nothing is listening while the project serves nothing', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);

    await expect(page.getByText('Nothing to preview yet')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/its application has not been started/)).toBeVisible();

    await stopRuntime(page, projectId);
  });

  test('finds the application once a server is started in the terminal', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await serveFromTerminal(page);

    await expect(page.getByText('port 8000')).toBeVisible({ timeout: 60_000 });

    await stopRuntime(page, projectId);
  });

  test('says why it cannot show the page inside the workspace over plain HTTP', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await serveFromTerminal(page);
    await expect(page.getByText('port 8000')).toBeVisible({ timeout: 60_000 });

    await expect(page.getByText(/will not carry the preview/)).toBeVisible();
    await expect(page.locator('iframe[title="Project preview"]')).toHaveCount(0);

    const preview = page.getByRole('region', { name: 'Preview' });
    await expect(preview.getByRole('textbox', { name: 'Preview URL' })).toHaveValue(
      new RegExp(`^http://${projectId}\\.`),
    );
    await expect(preview.getByRole('button', { name: 'Copy URL', exact: true })).toBeVisible();
    await expect(preview.getByRole('link', { name: 'Open in a tab', exact: true })).toHaveClass(
      /ui-button--primary/,
    );
    await expect(preview.locator('.ui-button--primary')).toHaveCount(1);

    await stopRuntime(page, projectId);
  });

  test('serves the preview from a different origin than the workspace', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await serveFromTerminal(page);
    await expect(page.getByText('port 8000')).toBeVisible({ timeout: 60_000 });

    const state = await (await page.request.get(`/api/projects/${projectId}/preview`)).json();
    expect(new URL(state.url).origin).not.toBe(new URL(page.url()).origin);
    expect(new URL(state.url).hostname.startsWith(projectId)).toBe(true);

    await stopRuntime(page, projectId);
  });

  test('shows the page the project serves, in a tab', async ({ page, context }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await serveFromTerminal(page);
    await expect(page.getByText('port 8000')).toBeVisible({ timeout: 60_000 });

    const link = page.getByRole('link', { name: 'Open in a tab', exact: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [tab] = await Promise.all([context.waitForEvent('page'), link.click()]);
      await expect(tab.locator('h1')).toHaveText(MARKER, { timeout: 60_000 });
      await tab.close();
    }

    const opened = await page.evaluate(() =>
      Object.keys(window.localStorage).some((key) => key.startsWith('onboarding.preview.v1.')),
    );
    expect(opened).toBe(true);

    await stopRuntime(page, projectId);
  });

  test('refuses a browser that was never let in', async ({ page, browser }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await serveFromTerminal(page);
    await expect(page.getByText('port 8000')).toBeVisible({ timeout: 60_000 });

    const state = await (await page.request.get(`/api/projects/${projectId}/preview`)).json();

    const stranger = await browser.newContext();
    const strangerPage = await stranger.newPage();
    const response = await strangerPage.goto(state.url as string);

    expect(response?.status()).toBe(401);
    await expect(strangerPage.locator('h1')).toHaveText('Not signed in for this preview');
    await stranger.close();

    await stopRuntime(page, projectId);
  });

  test('refuses a caller who is not a member', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await signOut(page);
    await signUp(page);

    expect((await page.request.get(`/api/projects/${projectId}/preview`)).status()).toBe(404);
    expect(
      (await page.request.post(`/api/projects/${projectId}/preview/grant`, { data: {} })).status(),
    ).toBe(404);
  });
});
