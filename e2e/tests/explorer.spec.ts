import { expect, test, type Page } from '@playwright/test';

/**
 * The file explorer in a real browser, against the real API and database.
 *
 * Every file created here is stored server-side, so the assertions after a
 * reload prove persistence rather than local state.
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
async function openWorkspace(page: Page): Promise<void> {
  await signUp(page);
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill('Explorer Test');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /Explorer Test/ }).click();
  await expect(page.getByRole('region', { name: 'Files' })).toBeVisible();
}

const explorer = (page: Page) => page.getByRole('region', { name: 'Files' });

/**
 * Creates an entry and waits until the reloaded tree shows it.
 *
 * Returning as soon as the key is pressed would let the next step act against
 * a tree that is about to be replaced, which loses focus and makes the suite
 * flaky for reasons that have nothing to do with the code.
 */
async function newFile(page: Page, name: string): Promise<void> {
  await explorer(page).getByRole('button', { name: 'New file' }).click();
  await page.getByLabel(/New file name/).fill(name);
  await page.getByLabel(/New file name/).press('Enter');
  await expect(page.getByRole('treeitem', { name: leafOf(name) })).toBeVisible();
}

async function newFolder(page: Page, name: string): Promise<void> {
  await explorer(page).getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel(/New folder name/).fill(name);
  await page.getByLabel(/New folder name/).press('Enter');
  await expect(page.getByRole('treeitem', { name: leafOf(name) })).toBeVisible();
}

/** A pattern matching the final segment of a path, escaped for a regex. */
function leafOf(path: string): RegExp {
  const leaf = path.split('/').pop() ?? path;
  return new RegExp(leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

test.describe('the file explorer', () => {
  test('a new project has no files and says so', async ({ page }) => {
    await openWorkspace(page);
    await expect(explorer(page).getByText('No files yet')).toBeVisible();
  });

  test('creates a file and shows it in the tree', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'index.js');

    await expect(page.getByRole('tree', { name: 'Project files' })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /index\.js/ })).toBeVisible();
  });

  test('the file is really stored, not just drawn', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'persisted.js');
    await expect(page.getByRole('treeitem', { name: /persisted\.js/ })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('treeitem', { name: /persisted\.js/ })).toBeVisible();
  });

  test('creates a folder and reveals what is inside it', async ({ page }) => {
    await openWorkspace(page);
    await newFolder(page, 'src');
    await expect(page.getByRole('treeitem', { name: /src/ })).toBeVisible();

    // Selecting the folder puts the next file inside it.
    await page.getByRole('treeitem', { name: /src/ }).click();
    await newFile(page, 'inner.js');

    await expect(page.getByRole('treeitem', { name: /inner\.js/ })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /inner\.js/ })).toHaveAttribute(
      'aria-level',
      '2',
    );
  });

  test('a nested path creates the folders it needs', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'a/b/c.js');

    // mkdir -p, so the tree has real entries for the folders rather than
    // showing something with nothing behind it. Creating also reveals the
    // path, so both folders are already open.
    await expect(page.getByRole('treeitem', { name: /^a/ })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /^b/ })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /c\.js/ })).toHaveAttribute('aria-level', '3');
  });

  test('collapses and expands a folder', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'src/a.js');

    const folder = page.getByRole('treeitem', { name: /^src/ });
    await expect(folder).toHaveAttribute('aria-expanded', 'true');

    await folder.click();
    await expect(page.getByRole('treeitem', { name: /^src/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(page.getByRole('treeitem', { name: /a\.js/ })).toHaveCount(0);
  });

  test('renames a file', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'old.js');

    await page.getByRole('treeitem', { name: /old\.js/ }).dblclick();
    await page.getByLabel('New name').fill('renamed.js');
    await page.getByLabel('New name').press('Enter');

    await expect(page.getByRole('treeitem', { name: /renamed\.js/ })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /old\.js/ })).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('treeitem', { name: /renamed\.js/ })).toBeVisible();
  });

  test('moves a file by renaming it into a folder', async ({ page }) => {
    // The way to move without a pointing device.
    await openWorkspace(page);
    await newFolder(page, 'lib');
    await newFile(page, 'loose.js');

    await page.getByRole('treeitem', { name: /loose\.js/ }).dblclick();
    await page.getByLabel('New name').fill('lib/loose.js');
    await page.getByLabel('New name').press('Enter');

    await expect(page.getByRole('treeitem', { name: /loose\.js/ })).toHaveAttribute(
      'aria-level',
      '2',
    );
  });

  test('deletes a file after confirming', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'doomed.js');

    await page.getByRole('treeitem', { name: /doomed\.js/ }).focus();
    await page.keyboard.press('Delete');

    const dialog = page.getByRole('alertdialog', { name: 'Confirm delete' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete' }).click();

    await expect(page.getByRole('treeitem', { name: /doomed\.js/ })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('treeitem', { name: /doomed\.js/ })).toHaveCount(0);
  });

  test('deletes a folder and everything in it', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'src/a.js');
    await newFile(page, 'keep.js');

    await page.getByRole('treeitem', { name: /^src/ }).focus();
    await page.keyboard.press('Delete');
    await page
      .getByRole('alertdialog', { name: 'Confirm delete' })
      .getByRole('button', { name: 'Delete' })
      .click();

    await expect(page.getByRole('treeitem', { name: /a\.js/ })).toHaveCount(0);
    await expect(page.getByRole('treeitem', { name: /keep\.js/ })).toBeVisible();
  });

  test('navigates the tree with the keyboard', async ({ page }) => {
    await openWorkspace(page);
    await newFolder(page, 'folder');
    await newFile(page, 'zeta.js');

    await page.getByRole('treeitem', { name: /folder/ }).focus();
    await page.keyboard.press('ArrowDown');

    // Directories come first, so down from the folder reaches the file.
    await expect(page.getByRole('treeitem', { name: /zeta\.js/ })).toBeFocused();
  });

  test('refuses a name that would escape the project', async ({ page }) => {
    await openWorkspace(page);

    let requested = false;
    await page.route('**/files/content', async (route) => {
      if (route.request().method() === 'PUT') requested = true;
      await route.continue();
    });

    // Not the helper: that waits for the entry to appear, and the point here
    // is that it never does.
    await explorer(page).getByRole('button', { name: 'New file' }).click();
    await page.getByLabel(/New file name/).fill('../escape.js');
    await page.getByLabel(/New file name/).press('Enter');

    await expect(explorer(page).getByRole('alert')).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /escape\.js/ })).toHaveCount(0);
    expect(requested).toBe(false);
  });

  test('selecting a file opens it in the editor', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'chosen.js');

    await page.getByRole('treeitem', { name: /chosen\.js/ }).click();

    await expect(page.getByRole('tab', { name: /chosen\.js/ })).toBeVisible();
    await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 });
  });

  test('another account cannot see these files', async ({ page, browser }) => {
    await openWorkspace(page);
    await newFile(page, 'private.js');
    const workspaceUrl = page.url();

    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signUp(otherPage);
    await otherPage.goto(workspaceUrl);

    await expect(otherPage.getByRole('heading', { name: 'Not found' })).toBeVisible();
    await expect(otherPage.getByText('private.js')).toHaveCount(0);

    await other.close();
  });
});
