import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Two people in one file, in two real browsers.
 *
 * Checks the shared-cursor path end to end: each browser's Yjs awareness goes
 * over the document socket, the server stamps it with the account's name and
 * colour, and the other browser's Monaco paints a remote caret for it. Nothing
 * here can be proved from one browser.
 */

function identity() {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    email: `e2e-${suffix}@example.test`,
    username: `e2e-${suffix}`,
    password: 'analytical-engine-1843',
  };
}

async function person(browser: Browser): Promise<{ page: Page; username: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const who = identity();
  await page.goto('/register');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Username').fill(who.username);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  return { page, username: who.username };
}

async function openFile(page: Page, projectId: string, name: string): Promise<void> {
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('region', { name: 'Files' })).toBeVisible();
  await page.getByRole('treeitem', { name: new RegExp(name.split('.')[0]!) }).click();
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 });
}

const painted = async (page: Page) =>
  ((await page.locator('.monaco-editor .view-lines').first().textContent()) ?? '').replaceAll(
    String.fromCharCode(0x00a0),
    ' ',
  );

test.describe('editing together', () => {
  test('each sees the other’s typing and caret', async ({ browser }) => {
    const ada = await person(browser);
    const grace = await person(browser);

    const created = await ada.page.request.post('/api/projects', { data: { name: 'Together' } });
    expect(created.status()).toBe(201);
    const projectId = (await created.json()).project.id as string;

    expect(
      (
        await ada.page.request.put(`/api/projects/${projectId}/files/content`, {
          data: { path: 'notes.txt', content: 'shared\n', encoding: 'utf8' },
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await ada.page.request.post(`/api/projects/${projectId}/members`, {
          data: { username: grace.username, role: 'EDITOR' },
        })
      ).status(),
    ).toBe(201);

    await openFile(ada.page, projectId, 'notes.txt');
    await openFile(grace.page, projectId, 'notes.txt');

    // Ada types; Grace sees it without reloading.
    await ada.page.locator('.monaco-editor .view-lines').first().click();
    await ada.page.keyboard.press('End');
    await ada.page.keyboard.type(' from ada');
    await expect.poll(() => painted(grace.page), { timeout: 15_000 }).toContain('from ada');

    // And Ada's caret is painted in Grace's editor, as a remote selection head.
    await expect(grace.page.locator('[class*="yRemoteSelectionHead-"]').first()).toBeAttached({
      timeout: 15_000,
    });

    // The other way round too.
    await grace.page.locator('.monaco-editor .view-lines').first().click();
    await grace.page.keyboard.type('grace was here ');
    await expect.poll(() => painted(ada.page), { timeout: 15_000 }).toContain('grace was here');
    await expect(ada.page.locator('[class*="yRemoteSelectionHead-"]').first()).toBeAttached({
      timeout: 15_000,
    });

    await ada.page.context().close();
    await grace.page.context().close();
  });

  test('one person alone is saved by the platform, not by the editor', async ({ browser }) => {
    const ada = await person(browser);
    const created = await ada.page.request.post('/api/projects', { data: { name: 'Solo' } });
    const projectId = (await created.json()).project.id as string;
    await ada.page.request.put(`/api/projects/${projectId}/files/content`, {
      data: { path: 'solo.txt', content: 'start', encoding: 'utf8' },
    });

    await openFile(ada.page, projectId, 'solo.txt');
    await expect(ada.page.getByText('Shared', { exact: true })).toBeVisible({ timeout: 15_000 });
    // Nothing for the editor's own button to do: there is no separate copy.
    await expect(ada.page.getByRole('button', { name: 'Save now' })).toBeDisabled();

    await ada.page.locator('.monaco-editor .view-lines').first().click();
    await ada.page.keyboard.press('End');
    await ada.page.keyboard.type(' and more');

    await expect(ada.page.getByText('Shared, saved')).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(
        async () =>
          (
            await (
              await ada.page.request.get(`/api/projects/${projectId}/files/content`, {
                params: { path: 'solo.txt' },
              })
            ).json()
          ).content as string,
        { timeout: 15_000 },
      )
      .toBe('start and more');

    await ada.page.context().close();
  });
});
