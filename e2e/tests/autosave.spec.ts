import { expect, test, type Page } from '@playwright/test';

/**
 * Autosave in a real browser.
 *
 * The component suite drives a fake clock against a mocked Monaco, which
 * proves the timing rules but not that they hold when the real editor, the
 * real network and the real database are in the loop. That is what this
 * covers: type, touch nothing, and check the bytes are in the database.
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

/** Signs up, makes a project, and returns its id. */
async function openWorkspace(page: Page): Promise<string> {
  await signUp(page);
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill('Autosave Test');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /Autosave Test/ }).click();
  await expect(page.getByRole('region', { name: 'Files' })).toBeVisible();
  return page.url().split('/projects/')[1]!;
}

async function newFile(page: Page, name: string): Promise<void> {
  await page
    .getByRole('region', { name: 'Files' })
    .getByRole('button', { name: 'New file' })
    .click();
  await page.getByLabel(/New file name/).fill(name);
  await page.getByLabel(/New file name/).press('Enter');
  await expect(page.getByRole('treeitem', { name: new RegExp(name.split('.')[0]!) })).toBeVisible();
}

async function openFile(page: Page, name: string): Promise<void> {
  await page.getByRole('treeitem', { name: new RegExp(name.split('.')[0]!) }).click();
  // Monaco is several megabytes and loads on demand, so the first open is slow.
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 });
}

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

/** The text Monaco has painted, with its non-breaking spaces normalised. */
async function editorText(page: Page): Promise<string> {
  const painted = (await page.locator('.monaco-editor .view-lines').first().textContent()) ?? '';
  return painted.replaceAll(String.fromCharCode(0x00a0), ' ');
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
