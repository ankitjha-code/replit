import { expect, test, type Page } from '@playwright/test';

/**
 * The code editor in a real browser, running the real Monaco against the real
 * API.
 *
 * The component suite mocks Monaco out, because jsdom cannot run it. This is
 * the only place the editor itself is exercised, so it covers what only a real
 * browser can show: that the editor loads, accepts typing, highlights, and
 * that what is typed reaches the database.
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

async function openWorkspace(page: Page): Promise<void> {
  await signUp(page);
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill('Editor Test');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /Editor Test/ }).click();
  await expect(page.getByRole('region', { name: 'Files' })).toBeVisible();
}

const explorer = (page: Page) => page.getByRole('region', { name: 'Files' });

async function newFile(page: Page, name: string): Promise<void> {
  await explorer(page).getByRole('button', { name: 'New file' }).click();
  await page.getByLabel(/New file name/).fill(name);
  await page.getByLabel(/New file name/).press('Enter');
  await expect(page.getByRole('treeitem', { name: new RegExp(name.split('.')[0]!) })).toBeVisible();
}

/** Opens a file from the explorer and waits for Monaco to be ready. */
async function openFile(page: Page, name: string): Promise<void> {
  await page.getByRole('treeitem', { name: new RegExp(name.split('.')[0]!) }).click();
  // Monaco is several megabytes and loads on demand, so the first open is slow.
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 });
}

/**
 * Types into the editor.
 *
 * Monaco keeps its real input off-screen and paints the text itself, so the
 * thing to click is the painted line area. Clicking the hidden input directly
 * fails the actionability check, which is the browser correctly refusing to
 * click something a person could not.
 */
async function typeInEditor(page: Page, text: string): Promise<void> {
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.type(text);
}

/**
 * The text Monaco has painted.
 *
 * Read from the line container rather than by querying for the whole string,
 * because Monaco splits a line across one element per syntax token and no
 * single element holds the sentence.
 */
async function editorText(page: Page): Promise<string> {
  const painted = (await page.locator('.monaco-editor .view-lines').first().textContent()) ?? '';
  // Monaco paints non-breaking spaces so that runs of spaces are not collapsed
  // by the browser. They are ordinary spaces in the buffer.
  return painted.replaceAll(String.fromCharCode(0x00a0), ' ');
}

/** The editor's own tabs. The console has a tablist too, and it is not this. */
function openFiles(page: Page) {
  return page.getByRole('tablist', { name: 'Open files' }).getByRole('tab');
}

test.describe('the code editor', () => {
  /*
   * The editor's own saving, which is what runs when no shared document is
   * available. With the document socket working, every file is shared and the
   * platform saves it instead (see collaboration.spec). These tests refuse that
   * socket so they keep checking the path an editor falls back to. They passed
   * before the socket was fixed only because it never connected.
   */
  test.beforeEach(async ({ page }) => {
    await page.routeWebSocket(/\/ws\/projects\/[^/]+\/document/, (ws) => ws.close());
  });

  test('opens a file into a real editor', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'index.js');
    await openFile(page, 'index.js');

    await expect(page.getByRole('tab', { name: /index\.js/ })).toBeVisible();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  });

  test('accepts typing and marks the file unsaved', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'index.js');
    await openFile(page, 'index.js');

    await typeInEditor(page, 'const answer = 42');

    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close index.js, unsaved' })).toBeVisible();
  });

  test('highlights syntax, so the language was actually detected', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'index.js');
    await openFile(page, 'index.js');

    await typeInEditor(page, 'const answer = 42');

    // Monaco marks tokens with classes; a keyword getting one proves the
    // language service is running rather than showing plain text.
    await expect(page.locator('.monaco-editor .mtk5, .monaco-editor .mtk6').first()).toBeVisible();
  });

  test('saves with the button, and the text really reaches the server', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'persist.js');
    await openFile(page, 'persist.js');

    await typeInEditor(page, 'const persisted = true');
    await page.getByRole('button', { name: 'Save now' }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();

    // Read back through the API: the plainest proof the bytes reached the
    // database, and it does not depend on how Monaco paints them.
    const projectId = page.url().split('/projects/')[1]!;
    const stored = await page.request.get(
      `/api/projects/${projectId}/files/content?path=persist.js`,
    );
    expect((await stored.json()).content).toBe('const persisted = true');

    // And a full reload shows it again, so the editor reads what was stored.
    await page.reload();
    await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 });
    // Monaco splits a line across token spans, so the assertion is on the
    // joined text of the line container rather than on one element.
    await expect.poll(() => editorText(page)).toContain('const persisted = true');
  });

  test('saves with Ctrl+S', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'shortcut.js');
    await openFile(page, 'shortcut.js');

    await typeInEditor(page, 'let viaKeyboard = 1');
    await page.keyboard.press('Control+s');

    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  });

  test('reopens the same tabs after a reload', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'first.js');
    await newFile(page, 'second.js');
    await openFile(page, 'first.js');
    await openFile(page, 'second.js');

    await expect(openFiles(page)).toHaveCount(2);

    await page.reload();
    await expect(openFiles(page)).toHaveCount(2);
  });

  test('keeps each tab its own content', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'alpha.js');
    await newFile(page, 'beta.js');

    await openFile(page, 'alpha.js');
    await typeInEditor(page, 'const alpha = 1');
    await page.keyboard.press('Control+s');
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();

    await openFile(page, 'beta.js');
    await typeInEditor(page, 'const beta = 2');
    await page.keyboard.press('Control+s');
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();

    await page.getByRole('tab', { name: /alpha\.js/ }).click();
    await expect.poll(() => editorText(page)).toContain('const alpha = 1');
    expect(await editorText(page)).not.toContain('const beta = 2');
  });

  test('closing a tab leaves the editor showing its neighbour', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'alpha.js');
    await newFile(page, 'beta.js');
    await openFile(page, 'alpha.js');
    await openFile(page, 'beta.js');

    await page.getByRole('button', { name: 'Close beta.js' }).click();

    await expect(openFiles(page)).toHaveCount(1);
    await expect(page.getByRole('tab', { name: /alpha\.js/ })).toBeVisible();
  });

  test('will not open a file that is not text', async ({ page }) => {
    await openWorkspace(page);
    const projectId = page.url().split('/projects/')[1]!;

    // Written through the API, because the explorer has no way to make a
    // binary file. page.request carries the browser's session.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    const written = await page.request.put(`/api/projects/${projectId}/files/content`, {
      data: { path: 'logo.png', content: bytes.toString('base64'), encoding: 'base64' },
    });
    expect(written.status()).toBe(200);

    await page.reload();
    await page.getByRole('treeitem', { name: /logo/ }).click();
    await expect(page.getByText(/not text, so it cannot be edited/)).toBeVisible();
  });
});
