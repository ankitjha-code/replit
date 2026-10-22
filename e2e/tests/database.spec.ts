import { expect, test, type Page } from '@playwright/test';
import { openWorkspace, stopRuntime, writeFile } from './helpers.js';

async function openSettings(page: Page, projectId: string) {
  await page.goto(`/projects/${projectId}/settings`);
  await expect(page).toHaveURL(/\/settings\/general$/);
  await page
    .getByRole('navigation', { name: 'Project settings' })
    .getByRole('link', { name: 'Database' })
    .click();
  await expect(page).toHaveURL(/\/settings\/database$/);
  await expect(
    page.getByRole('heading', { level: 2, name: 'Database', exact: true }),
  ).toBeVisible();
}

const PROBE =
  "/*\n * Proves this container can reach a real PostgreSQL server at PGHOST.\n *\n * Opens a socket and sends the eight-byte SSLRequest that begins the PostgreSQL\n * wire protocol. A server that answers 'N' or 'S' is speaking that protocol; an\n * open port that answers anything else, or nothing, is not. That distinction is\n * the point: a TCP connect on its own proves only that something is listening.\n */\nconst net = require('node:net');\n\nconst socket = net.connect(Number(process.env.PGPORT), process.env.PGHOST, () => {\n  const request = Buffer.alloc(8);\n  request.writeInt32BE(8, 0);\n  request.writeInt32BE(80877103, 4);\n  socket.write(request);\n});\n\nsocket.on('data', (data) => {\n  console.log('db' + '-speaks-' + String.fromCharCode(data[0]));\n  socket.end();\n});\n\nsocket.on('error', (error) => {\n  console.log('db' + '-error-' + error.code);\n});\n";

test.describe('a project database', () => {
  test('says there is none, then makes one', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await openSettings(page, projectId);

    await expect(page.getByText('This project has no database.')).toBeVisible();
    await page.getByRole('button', { name: 'Create a database' }).click();

    await expect(page.getByText('platform-userdb').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('5432', { exact: true })).toBeVisible();
  });

  test('keeps the password hidden until it is asked for', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await openSettings(page, projectId);
    await page.getByRole('button', { name: 'Create a database' }).click();
    await expect(page.getByText('platform-userdb').first()).toBeVisible({ timeout: 60_000 });

    const hidden = page.getByRole('button', { name: 'Show password' });
    await expect(hidden).toBeVisible();
    await hidden.click();
    await expect(page.getByRole('button', { name: 'Show password' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Hide password' })).toBeVisible();
  });

  test('survives a reload, because it is on the server', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await openSettings(page, projectId);
    await page.getByRole('button', { name: 'Create a database' }).click();
    await expect(page.getByText('platform-userdb').first()).toBeVisible({ timeout: 60_000 });

    await page.reload();
    await expect(page.getByText('platform-userdb').first()).toBeVisible();
    await expect(page.getByText('This project has no database.')).toBeHidden();
  });

  test('refuses a second one rather than replacing the first', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await openSettings(page, projectId);
    await page.getByRole('button', { name: 'Create a database' }).click();
    await expect(page.getByText('platform-userdb').first()).toBeVisible({ timeout: 60_000 });

    const again = await page.request.post(`/api/projects/${projectId}/database`, { data: {} });
    expect(again.status()).toBe(409);
  });

  test('the project container reaches a real PostgreSQL server', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await openWorkspace(page);

    await writeFile(page, projectId, 'package.json', '{}');
    await writeFile(page, projectId, 'dbcheck.js', PROBE);

    await openSettings(page, projectId);
    await page.getByRole('button', { name: 'Create a database' }).click();
    await expect(page.getByText('platform-userdb').first()).toBeVisible({ timeout: 60_000 });

    await page.goto(`/projects/${projectId}`);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page.locator('.runtime-chip')).toHaveText('Running', { timeout: 280_000 });

    await page.getByRole('tab', { name: 'Shell', exact: true }).click();
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await page.locator('.xterm-screen').first().click();
    await page.keyboard.type('node dbcheck.js');
    await page.keyboard.press('Enter');

    await expect
      .poll(async () => (await page.locator('.xterm-rows').first().textContent()) ?? '', {
        timeout: 60_000,
      })
      .toMatch(/db-speaks-[NS]/);

    await stopRuntime(page, projectId);
  });

  test('an application with no database is told nothing about one', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await openWorkspace(page);
    await writeFile(page, projectId, 'package.json', '{}');

    await page.goto(`/projects/${projectId}`);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page.locator('.runtime-chip')).toHaveText('Running', { timeout: 280_000 });

    await page.getByRole('tab', { name: 'Shell', exact: true }).click();
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await page.locator('.xterm-screen').first().click();
    await page.keyboard.type('echo "[$PGHOST]" && echo probe\'\'-done');
    await page.keyboard.press('Enter');

    await expect
      .poll(async () => (await page.locator('.xterm-rows').first().textContent()) ?? '', {
        timeout: 60_000,
      })
      .toMatch(/probe-done/);

    const screen = (await page.locator('.xterm-rows').first().textContent()) ?? '';
    expect(screen).toContain('[]');

    await stopRuntime(page, projectId);
  });
});
