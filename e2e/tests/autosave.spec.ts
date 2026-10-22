import { expect, test, type Page } from '@playwright/test';
import { editorText, newFile, openFile, openWorkspace } from './helpers.js';

/**
 * Autosave in a real browser.
 *
 * The component suite drives a fake clock against a mocked Monaco, which
 * proves the timing rules but not that they hold when the real editor, the
 * real network and the real database are in the loop. That is what this
 * covers: type, touch nothing, and check the bytes are in the database.
 */

/**
 * Puts the caret in the editor.
 *
 * Monaco keeps its real input off-screen, so the painted lines are the thing a
 * person would click. Clicking again when the editor already has focus is
 * skipped, because the suggestion popup floats over those lines and would
 * swallow the click.
 */
async function focusEditor(page: Page): Promise<void> {
  // Asked of the document rather than of a known input element, because which
  // element Monaco focuses is a detail of its own that changes between
  // versions.
  const focused = await page.evaluate(() =>
    Boolean(document.activeElement?.closest('.monaco-editor')),
  );
  if (focused) return;
  await page.locator('.monaco-editor .view-lines').first().click();
}

async function typeInEditor(page: Page, text: string): Promise<void> {
  await focusEditor(page);
  await page.keyboard.type(text);
  // Leave no suggestion popup open, which is also where a person would leave
  // the editor before looking at anything else.
  await page.keyboard.press('Escape');
}

/** What is actually in the database, read through the API. */
async function storedContent(page: Page, projectId: string, path: string): Promise<string> {
  const response = await page.request.get(
    `/api/projects/${projectId}/files/content?path=${encodeURIComponent(path)}`,
  );
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { content: string };
  return body.content;
}

/**
 * Waits until the server really holds this text.
 *
 * The status line cannot be used for this. A file that has just been opened and
 * not yet edited already reads "Saved", so waiting for that label passes the
 * instant it is asked and proves nothing at all: under load the read that
 * follows then wins the race against the save, and the test fails for a reason
 * that has nothing to do with autosave. This polls the claim these tests are
 * actually making.
 */
async function awaitStored(
  page: Page,
  projectId: string,
  path: string,
  expected: string,
): Promise<void> {
  await expect.poll(() => storedContent(page, projectId, path), { timeout: 15_000 }).toBe(expected);
}

test.describe('autosave', () => {
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

  test('stores what was typed without the file being saved by hand', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await newFile(page, 'auto.js');
    await openFile(page, 'auto.js');

    await typeInEditor(page, 'const saved = 1');

    // No button, no Ctrl+S. What the server holds is the proof, and waiting
    // for it is also the only sound way to wait.
    await awaitStored(page, projectId, 'auto.js', 'const saved = 1');
  });

  test('survives a reload, so the save was durable and not just optimistic', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await newFile(page, 'durable.js');
    await openFile(page, 'durable.js');

    await typeInEditor(page, 'const durable = true');
    // Reloading before the save has landed would test nothing but the race.
    await awaitStored(page, projectId, 'durable.js', 'const durable = true');

    await page.reload();
    await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => editorText(page), { timeout: 15_000 })
      .toContain('const durable = true');
  });

  test('saves during continuous typing rather than waiting for a pause', async ({ page }) => {
    // Someone typing steadily for an hour would otherwise have nothing stored,
    // and a crash would lose all of it.
    const projectId = await openWorkspace(page);
    await newFile(page, 'ceiling.js');
    await openFile(page, 'ceiling.js');

    // Counted from the browser rather than read back from the database,
    // because a read takes long enough to let the quiet period elapse, which
    // would let this pass for the wrong reason.
    let saves = 0;
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/files/content')) saves += 1;
    });

    await focusEditor(page);
    // Keystrokes spaced under the quiet period, sustained past the ceiling, so
    // nothing here could have been triggered by typing stopping.
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.type('x');
      await page.waitForTimeout(300);
    }
    const duringTyping = saves;

    expect(duringTyping).toBeGreaterThan(0);
    await expect
      .poll(async () => (await storedContent(page, projectId, 'ceiling.js')).length, {
        timeout: 15_000,
      })
      .toBe(30);
  });

  test('offers a choice when the file changed elsewhere, and loses nothing', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await newFile(page, 'shared.js');
    await openFile(page, 'shared.js');

    await typeInEditor(page, 'mine');
    await awaitStored(page, projectId, 'shared.js', 'mine');

    // A second writer, standing in for another tab or a collaborator. This
    // moves the version past the one the editor is holding.
    const written = await page.request.put(`/api/projects/${projectId}/files/content`, {
      data: { path: 'shared.js', content: 'theirs', encoding: 'utf8' },
    });
    expect(written.status()).toBe(200);

    await typeInEditor(page, ' and more');
    await expect(page.getByText(/changed elsewhere while you were editing/)).toBeVisible({
      timeout: 15_000,
    });

    // Nothing is written behind the person's back while the decision is open.
    expect(await storedContent(page, projectId, 'shared.js')).toBe('theirs');

    await page.getByRole('button', { name: 'Keep mine' }).click();
    await expect
      .poll(() => storedContent(page, projectId, 'shared.js'), { timeout: 15_000 })
      .toContain('and more');
  });

  test('shows the two versions side by side before the choice is made', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await newFile(page, 'compare.js');
    await openFile(page, 'compare.js');

    await typeInEditor(page, 'mine');
    await awaitStored(page, projectId, 'compare.js', 'mine');

    await page.request.put(`/api/projects/${projectId}/files/content`, {
      data: { path: 'compare.js', content: 'const theirs = 1', encoding: 'utf8' },
    });

    await typeInEditor(page, '!');
    await expect(page.getByText(/changed elsewhere while you were editing/)).toBeVisible({
      timeout: 15_000,
    });

    // Exact, because the tab's "Close compare.js" button also contains the word.
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /Compare versions of compare\.js/ });
    await expect(dialog).toBeVisible();
    // A real Monaco diff, with the server's text on one side and the typed
    // text on the other.
    await expect(dialog.locator('.monaco-diff-editor')).toBeVisible({ timeout: 30_000 });
    // `.editor.original`, not `.original`: the overview ruler canvas shares the class.
    await expect(dialog.locator('.monaco-diff-editor .editor.original')).toContainText('theirs');
    await expect(dialog.locator('.monaco-diff-editor .editor.modified')).toContainText('mine!');

    // Deciding from the comparison resolves the conflict the same way the bar does.
    await dialog.getByRole('button', { name: 'Keep mine' }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(() => storedContent(page, projectId, 'compare.js'), { timeout: 15_000 })
      .toBe('mine!');
  });

  test('taking theirs replaces the buffer with what the server holds', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await newFile(page, 'yield.js');
    await openFile(page, 'yield.js');

    await typeInEditor(page, 'mine');
    await awaitStored(page, projectId, 'yield.js', 'mine');

    await page.request.put(`/api/projects/${projectId}/files/content`, {
      data: { path: 'yield.js', content: 'const theirs = 1', encoding: 'utf8' },
    });

    await typeInEditor(page, '!');
    await expect(page.getByText(/changed elsewhere while you were editing/)).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('button', { name: 'Use theirs' }).click();

    await expect.poll(() => editorText(page), { timeout: 15_000 }).toContain('const theirs = 1');
    expect(await storedContent(page, projectId, 'yield.js')).toBe('const theirs = 1');
  });
});
