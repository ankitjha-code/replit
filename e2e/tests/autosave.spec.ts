import { expect, test, type Page } from '@playwright/test';
import { editorText, newFile, openFile, openWorkspace } from './helpers.js';

async function focusEditor(page: Page): Promise<void> {
  const focused = await page.evaluate(() =>
    Boolean(document.activeElement?.closest('.monaco-editor')),
  );
  if (focused) return;
  await page.locator('.monaco-editor .view-lines').first().click();
}

async function typeInEditor(page: Page, text: string): Promise<void> {
  await focusEditor(page);
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
}

async function storedContent(page: Page, projectId: string, path: string): Promise<string> {
  const response = await page.request.get(
    `/api/projects/${projectId}/files/content?path=${encodeURIComponent(path)}`,
  );
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { content: string };
  return body.content;
}

async function awaitStored(
  page: Page,
  projectId: string,
  path: string,
  expected: string,
): Promise<void> {
  await expect.poll(() => storedContent(page, projectId, path), { timeout: 15_000 }).toBe(expected);
}

test.describe('autosave', () => {
  test.beforeEach(async ({ page }) => {
    await page.routeWebSocket(/\/ws\/projects\/[^/]+\/document/, (ws) => ws.close());
  });

  test('stores what was typed without the file being saved by hand', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await newFile(page, 'auto.js');
    await openFile(page, 'auto.js');

    await typeInEditor(page, 'const saved = 1');

    await awaitStored(page, projectId, 'auto.js', 'const saved = 1');
  });

  test('survives a reload, so the save was durable and not just optimistic', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await newFile(page, 'durable.js');
    await openFile(page, 'durable.js');

    await typeInEditor(page, 'const durable = true');
    await awaitStored(page, projectId, 'durable.js', 'const durable = true');

    await page.reload();
    await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => editorText(page), { timeout: 15_000 })
      .toContain('const durable = true');
  });

  test('saves during continuous typing rather than waiting for a pause', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await newFile(page, 'ceiling.js');
    await openFile(page, 'ceiling.js');

    let saves = 0;
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/files/content')) saves += 1;
    });

    await focusEditor(page);
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

    const written = await page.request.put(`/api/projects/${projectId}/files/content`, {
      data: { path: 'shared.js', content: 'theirs', encoding: 'utf8' },
    });
    expect(written.status()).toBe(200);

    await typeInEditor(page, ' and more');
    await expect(page.getByText(/changed elsewhere while you were editing/)).toBeVisible({
      timeout: 15_000,
    });

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

    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /Compare versions of compare\.js/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.monaco-diff-editor')).toBeVisible({ timeout: 30_000 });
    await expect(dialog.locator('.monaco-diff-editor .editor.original')).toContainText('theirs');
    await expect(dialog.locator('.monaco-diff-editor .editor.modified')).toContainText('mine!');

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
