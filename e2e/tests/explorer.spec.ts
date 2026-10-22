import { expect, test, type Page } from '@playwright/test';
import { explorer, leafOf, newFile, openWorkspace, signUp } from './helpers.js';

/**
 * The file explorer in a real browser, against the real API and database.
 *
 * Every file created here is stored server-side, so the assertions after a
 * reload prove persistence rather than local state.
 */

async function newFolder(page: Page, name: string): Promise<void> {
  await explorer(page).getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel(/New folder name/).fill(name);
  await page.getByLabel(/New folder name/).press('Enter');
  await expect(page.getByRole('treeitem', { name: leafOf(name) })).toBeVisible();
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
    // keep.js first: a new file goes into the folder of whatever is selected,
    // so creating it after src/a.js would put it inside src.
    await newFile(page, 'keep.js');
    await newFile(page, 'src/a.js');

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

  test('a new file opens in the editor straight away', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'fresh.js');

    await expect(page.getByRole('tab', { name: /fresh\.js/ })).toBeVisible();
  });

  test('renames from the context menu', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'menu.js');

    await page.getByRole('treeitem', { name: 'menu.js', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Rename/ }).click();
    const field = page.getByLabel('New name');
    await expect(field).toBeFocused();
    await field.fill('menu-renamed.js');
    await field.press('Enter');

    await expect(
      page.getByRole('treeitem', { name: 'menu-renamed.js', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('treeitem', { name: 'menu.js', exact: true })).toHaveCount(0);
  });

  test('moves a file into a folder by dragging it', async ({ page }) => {
    await openWorkspace(page);
    await newFolder(page, 'target');
    await newFile(page, 'dragged.js');

    await page
      .getByRole('treeitem', { name: 'dragged.js', exact: true })
      .dragTo(page.getByRole('treeitem', { name: 'target', exact: true }));

    await expect(page.getByRole('treeitem', { name: 'dragged.js', exact: true })).toHaveAttribute(
      'aria-level',
      '2',
    );
  });

  test('finds a file by name and opens it', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'src/server.js');
    await newFile(page, 'other.js');

    await explorer(page).getByRole('searchbox', { name: 'Search files' }).fill('serv');
    const result = explorer(page)
      .getByRole('list', { name: 'Search results' })
      .getByRole('button', { name: /server\.js/ });
    await expect(result).toBeVisible();
    await result.click();

    await expect(page.getByRole('tab', { name: /server\.js/ })).toBeVisible();
  });

  test('uploads a file from the device', async ({ page }) => {
    await openWorkspace(page);

    await explorer(page)
      .locator('input[type="file"]')
      .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });

    await expect(page.getByRole('treeitem', { name: 'notes.txt', exact: true })).toBeVisible();
    await expect(page.locator('.ui-toast').getByText('Uploaded notes.txt')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('treeitem', { name: 'notes.txt', exact: true })).toBeVisible();
  });

  test('remembers which folders were open', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'kept/open.js');
    await expect(page.getByRole('treeitem', { name: 'kept', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    await page.reload();
    await expect(page.getByRole('treeitem', { name: 'open.js', exact: true })).toBeVisible();
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
