import { expect, test, type Page } from '@playwright/test';
import { editorText, newFile, openFile, openWorkspace } from './helpers.js';

/**
 * The code editor in a real browser, running the real Monaco against the real
 * API.
 *
 * The component suite mocks Monaco out, because jsdom cannot run it. This is
 * the only place the editor itself is exercised, so it covers what only a real
 * browser can show: that the editor loads, accepts typing, highlights, and
 * that what is typed reaches the database.
 */

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

    // Monaco gives every token a class per colour rule; two different ones on
    // the line proves the language service is running rather than showing
    // plain text. Which numbers they get depends on the theme, so the test
    // counts kinds instead of naming them.
    await expect
      .poll(async () => {
        const classes = await page
          .locator('.monaco-editor .view-lines [class*="mtk"]')
          .evaluateAll((spans) =>
            spans.flatMap((span) => Array.from(span.classList).filter((c) => /^mtk\d+$/.test(c))),
          );
        return new Set(classes).size;
      })
      .toBeGreaterThanOrEqual(2);
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

  test('asks before closing a tab with unsaved changes, and saves when told to', async ({
    page,
  }) => {
    await openWorkspace(page);
    await newFile(page, 'guarded.js');
    await openFile(page, 'guarded.js');
    const projectId = page.url().split('/projects/')[1]!;

    // Typed and closed inside the autosave quiet period, so the buffer is
    // still unsaved at the moment the close is asked for.
    await typeInEditor(page, 'const kept = true');
    await page.getByRole('button', { name: 'Close guarded.js, unsaved' }).click();

    const dialog = page.getByRole('dialog', { name: 'Save changes to guarded.js?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Save and close' }).click();

    await expect(openFiles(page)).toHaveCount(0);
    await expect(page.getByText('Nothing open')).toBeVisible();
    const stored = await page.request.get(
      `/api/projects/${projectId}/files/content?path=guarded.js`,
    );
    expect((await stored.json()).content).toBe('const kept = true');
  });

  test('keeps the tab and the text when the close is cancelled', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'kept.js');
    await openFile(page, 'kept.js');

    await typeInEditor(page, 'still here');
    await page.getByRole('button', { name: 'Close kept.js, unsaved' }).click();

    const dialog = page.getByRole('dialog', { name: 'Save changes to kept.js?' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('tab', { name: /kept\.js/ })).toBeVisible();
    await expect.poll(() => editorText(page)).toContain('still here');
  });

  test('discards unsaved changes only when told to', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'dropped.js');
    await openFile(page, 'dropped.js');
    const projectId = page.url().split('/projects/')[1]!;

    // Closed inside the autosave quiet period, so Discard really has
    // something to drop; the file on the server stays as it was created.
    await typeInEditor(page, 'gone');
    await page.getByRole('button', { name: 'Close dropped.js, unsaved' }).click();
    await page
      .getByRole('dialog', { name: 'Save changes to dropped.js?' })
      .getByRole('button', { name: 'Discard' })
      .click();

    await expect(openFiles(page)).toHaveCount(0);
    const stored = await page.request.get(
      `/api/projects/${projectId}/files/content?path=dropped.js`,
    );
    expect((await stored.json()).content).toBe('');
  });

  test('follows the light theme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openWorkspace(page);
    await newFile(page, 'light.js');
    await openFile(page, 'light.js');

    // Monaco cannot read CSS variables, so its theme is rebuilt from the
    // tokens; the proof is that its canvas is the page's --bg-canvas, resolved
    // the same way the browser resolves it for any other element.
    const colours = () =>
      page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.backgroundColor = getComputedStyle(document.documentElement)
          .getPropertyValue('--bg-canvas')
          .trim();
        document.body.appendChild(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const editor = document.querySelector('.monaco-editor .monaco-editor-background');
        return { expected, actual: editor ? getComputedStyle(editor).backgroundColor : null };
      });
    await expect.poll(async () => (await colours()).actual).toBe((await colours()).expected);
    // And light really is light: the canvas is near white.
    expect((await colours()).expected).toMatch(/^rgb\(2\d\d, 2\d\d, 2\d\d\)$/);
  });

  test('has per-viewer editor settings that apply at once', async ({ page }) => {
    await openWorkspace(page);
    await newFile(page, 'sized.js');
    await openFile(page, 'sized.js');

    await page.getByRole('button', { name: 'Editor settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Editor settings' });
    await dialog.getByLabel('Font size').selectOption('16');
    await dialog.getByRole('button', { name: 'Done' }).click();

    await expect
      .poll(() =>
        page.evaluate(() => {
          const lines = document.querySelector('.monaco-editor .view-lines');
          return lines ? getComputedStyle(lines).fontSize : null;
        }),
      )
      .toBe('16px');

    // Remembered for this browser, not for the project.
    expect(
      await page.evaluate(() => JSON.parse(window.localStorage.getItem('ui.editor') ?? '{}')),
    ).toMatchObject({ fontSize: 16 });
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
