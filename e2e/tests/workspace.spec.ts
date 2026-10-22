import { expect, test, type Page } from '@playwright/test';
import { openWorkspace, signUp } from './helpers.js';

test.describe('the workspace', () => {
  test('opening a project lands in the workspace, not a form', async ({ page }) => {
    await openWorkspace(page, 'Straight In');

    for (const region of ['Files', 'Editor', 'Console', 'Preview']) {
      await expect(page.getByRole('region', { name: region })).toBeVisible();
    }
  });

  test('names the project in the toolbar', async ({ page }) => {
    await openWorkspace(page, 'Named Project');
    await expect(page.getByText('Named Project', { exact: true })).toBeVisible();
    await expect(page.getByText('/named-project')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Named Project');
    await expect(page).toHaveTitle('Named Project · Workspace');
  });

  test('the toolbar carries the account menu, since there is no header here', async ({ page }) => {
    await openWorkspace(page);
    await expect(page.getByRole('banner')).toHaveCount(0);
    await expect(page.locator('.account-menu__trigger')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Deploy$/ })).toHaveCount(0);
  });

  test('says the project is not running rather than showing one as ready', async ({ page }) => {
    await openWorkspace(page);
    await expect(page.locator('.runtime-chip')).toHaveText('Not running');
  });

  test('each region says it is empty rather than imitating the real thing', async ({ page }) => {
    await openWorkspace(page);

    await expect(page.getByText('No files yet')).toBeVisible();
    await expect(page.getByText('Nothing open')).toBeVisible();
    await expect(page.getByText(/Start the environment before running the app/)).toBeVisible();
    await page.getByRole('tab', { name: 'Shell', exact: true }).click();
    await expect(page.getByText('Nothing is running')).toBeVisible();
    await expect(page.getByText('Nothing to preview')).toBeVisible();
  });

  test('a divider can be dragged to resize a panel', async ({ page }) => {
    await openWorkspace(page);

    const divider = page.getByRole('separator', { name: 'Resize the files panel' });
    const before = Number(await divider.getAttribute('aria-valuenow'));

    const box = (await divider.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 160, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();

    await expect
      .poll(async () => Number(await divider.getAttribute('aria-valuenow')))
      .toBeGreaterThan(before);
  });

  test('a divider can be moved with the keyboard', async ({ page }) => {
    await openWorkspace(page);

    const divider = page.getByRole('separator', { name: 'Resize the console panel' });
    const before = Number(await divider.getAttribute('aria-valuenow'));

    await divider.focus();
    await page.keyboard.press('ArrowUp');

    await expect
      .poll(async () => Number(await divider.getAttribute('aria-valuenow')))
      .toBeGreaterThan(before);
  });

  test('a hidden panel keeps a way back', async ({ page }) => {
    await openWorkspace(page);

    await page.getByRole('button', { name: 'Hide preview' }).click();
    await expect(page.getByRole('region', { name: 'Preview' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Show preview' }).click();
    await expect(page.getByRole('region', { name: 'Preview' })).toBeVisible();
  });

  test('the arrangement survives a reload', async ({ page }) => {
    await openWorkspace(page);

    await page.getByRole('button', { name: 'Hide console' }).click();
    await expect(page.getByRole('button', { name: 'Show console' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('button', { name: 'Show console' })).toBeVisible();
  });

  test('the arrangement carries to another project', async ({ page }) => {
    await openWorkspace(page, 'First Project');
    await page.getByRole('button', { name: 'Hide files' }).click();
    await expect(page.getByRole('button', { name: 'Show files' })).toBeVisible();

    await page.getByRole('link', { name: 'All projects' }).click();
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Project name').fill('Second Project');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByRole('link', { name: /Second Project/ }).click();

    await expect(page.getByRole('button', { name: 'Show files' })).toBeVisible();
  });

  test('Reset layout restores the default arrangement', async ({ page }) => {
    await openWorkspace(page);

    const reset = page.getByRole('button', { name: 'Reset layout' });
    await expect(reset).toBeDisabled();
    await expect(reset).toHaveAccessibleDescription('Layout is already the default');

    await page.getByRole('button', { name: 'Hide files' }).click();
    await expect(reset).toBeEnabled();
    await reset.click();

    await expect(page.getByRole('region', { name: 'Files' })).toBeVisible();
    await expect(reset).toBeDisabled();
  });

  test('settings are a separate page reached from the workspace', async ({ page }) => {
    await openWorkspace(page, 'Has Settings');

    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Has Settings' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete project' })).toBeVisible();

    await page.getByRole('link', { name: 'Open workspace' }).click();
    await expect(page.getByRole('region', { name: 'Editor' })).toBeVisible();
  });

  test('another account cannot open the workspace', async ({ page, browser }) => {
    await openWorkspace(page, 'Private Workspace');
    const workspaceUrl = page.url();

    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signUp(otherPage);
    await otherPage.goto(workspaceUrl);

    await expect(otherPage.getByRole('heading', { name: 'Not found' })).toBeVisible();
    await expect(otherPage.getByRole('region', { name: 'Editor' })).toHaveCount(0);

    await other.close();
  });

  test('an anonymous visitor is sent to sign in', async ({ page, browser }) => {
    await openWorkspace(page, 'Needs Auth');
    const workspaceUrl = page.url();

    const anonymous = await browser.newContext();
    const anonymousPage = await anonymous.newPage();
    await anonymousPage.goto(workspaceUrl);

    await expect(anonymousPage.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    await anonymous.close();
  });
});

test.describe('the workspace on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  async function openOnPhone(page: Page): Promise<string> {
    await signUp(page);
    const created = await page.request.post('/api/projects', { data: { name: 'Pocket' } });
    expect(created.status()).toBe(201);
    const projectId = (await created.json()).project.id as string;
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByRole('region', { name: 'Editor' })).toBeVisible();
    return projectId;
  }

  test('shows one panel at a time and switches between them', async ({ page }) => {
    await openOnPhone(page);

    const switcher = page.getByRole('tablist', { name: 'Workspace panels' });
    await expect(switcher.getByRole('tab', { name: 'Editor' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('region', { name: 'Files' })).toBeHidden();

    await switcher.getByRole('tab', { name: 'Files' }).click();
    await expect(page.getByRole('region', { name: 'Files' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Editor' })).toBeHidden();

    await switcher.getByRole('tab', { name: 'Console' }).click();
    await expect(page.getByRole('region', { name: 'Console' })).toBeVisible();
    await expect(page.getByText(/Start the environment before running the app/)).toBeVisible();

    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBe(widths.client);
  });

  test('Start can be pressed and nothing covers it', async ({ page }) => {
    await openOnPhone(page);

    const start = page.getByRole('button', { name: 'Start', exact: true });
    await expect(start).toBeEnabled();

    const box = (await start.boundingBox())!;
    const hit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x!, y!)?.closest('button')?.textContent ?? null,
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(hit).toBe('Start');

    await start.click();
    await expect(page.getByRole('dialog', { name: 'What does this project run?' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: 'More' }).click();
    for (const item of ['Share', 'Settings', 'Reset layout', 'Keyboard shortcuts']) {
      await expect(page.getByRole('menuitem', { name: item })).toBeVisible();
    }
  });
});
