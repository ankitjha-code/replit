import { expect, test, type Page } from '@playwright/test';

/**
 * The workspace shell in a real browser.
 *
 * What is under test is the arrangement someone lands in when they open a
 * project: the regions are there, they can be resized and hidden, and the
 * arrangement survives a reload.
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

/** Signs up, creates a project, and opens its workspace. */
async function openWorkspace(page: Page, name = 'Workspace Test'): Promise<void> {
  await signUp(page);
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await expect(page.getByRole('region', { name: 'Editor' })).toBeVisible();
}

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
  });

  test('says the project is not running rather than showing one as ready', async ({ page }) => {
    await openWorkspace(page);
    // Not "Ready". A project nobody has started is not running, and the chip
    // says exactly that.
    await expect(page.locator('.runtime-chip')).toHaveText('Not running');
  });

  test('each region says it is empty rather than imitating the real thing', async ({ page }) => {
    await openWorkspace(page);

    await expect(page.getByText('No files yet')).toBeVisible();
    await expect(page.getByText('Nothing open')).toBeVisible();
    // The console opens on the output tab and says why there is nothing to
    // show, rather than an empty black rectangle that looks like a live log.
    await expect(page.getByText(/Start the project before running it/)).toBeVisible();
    // Its other tab says why there is no terminal, which is the fact someone
    // can act on.
    await page.getByRole('tab', { name: 'Shell' }).click();
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
    // One layout for how a person works, not one per project.
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

    await page.getByRole('button', { name: 'Hide files' }).click();
    await page.getByRole('button', { name: 'Reset layout' }).click();

    await expect(page.getByRole('region', { name: 'Files' })).toBeVisible();
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
