import { expect, type Page } from '@playwright/test';

export function uniqueIdentity() {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    email: `e2e-${suffix}@example.test`,
    username: `e2e-${suffix}`,
    password: 'analytical-engine-1843',
  };
}

export type Identity = ReturnType<typeof uniqueIdentity>;

export async function signUp(page: Page, identity: Identity = uniqueIdentity()): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Email', { exact: true }).fill(identity.email);
  await page.getByLabel('Username', { exact: true }).fill(identity.username);
  await page.getByLabel('Password', { exact: true }).fill(identity.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expectSignedIn(page);
}

export async function expectSignedIn(page: Page): Promise<void> {
  await expect(accountMenuTrigger(page)).toBeVisible();
}

export async function signOut(page: Page): Promise<void> {
  if (!(await accountMenuTrigger(page).isVisible())) {
    await page.goto('/');
  }
  await accountMenuTrigger(page).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
}

function accountMenuTrigger(page: Page) {
  return page.locator('.account-menu__trigger');
}

export async function signIn(page: Page, identifier: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email or username', { exact: true }).fill(identifier);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function createProject(page: Page, name: string): Promise<void> {
  const start = page.getByRole('button', { name: 'Create your first project' });
  if (await start.isVisible().catch(() => false)) {
    await start.click();
  } else {
    await page.getByRole('button', { name: 'New project' }).click();
  }

  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
}

export async function openWorkspace(page: Page, name = 'Workspace Test'): Promise<string> {
  await signUp(page);
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await expect(page.getByRole('region', { name: 'Files' })).toBeVisible();
  return page.url().split('/projects/')[1]!;
}

export async function writeFile(
  page: Page,
  projectId: string,
  path: string,
  content = '{}',
): Promise<void> {
  const response = await page.request.put(`/api/projects/${projectId}/files/content`, {
    data: { path, content, encoding: 'utf8' },
  });
  expect(response.status()).toBe(200);
}

export async function startRuntime(page: Page): Promise<void> {
  const chip = page.locator('.runtime-chip');
  await expect
    .poll(
      async () => {
        const [text, title] = await Promise.all([chip.textContent(), chip.getAttribute('title')]);
        if (!text || /Checking/.test(text)) return 'loading';
        if (!title || /^Choose what this project runs/.test(title)) return 'undetected';
        return 'ready';
      },
      { timeout: 15_000 },
    )
    .toBe('ready');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('.runtime-chip')).toHaveText('Running', { timeout: 280_000 });
}

export async function startedProject(
  page: Page,
  options: { name?: string; marker?: string } = {},
): Promise<string> {
  const projectId = await openWorkspace(page, options.name);
  await writeFile(page, projectId, 'index.html', `<h1>${options.marker ?? 'hello'}</h1>`);
  await startRuntime(page);
  return projectId;
}

export async function stopRuntime(page: Page, projectId: string): Promise<void> {
  await page.request.post(`/api/projects/${projectId}/runtime/stop`, { data: {} });
}

export async function openShell(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Shell', exact: true }).click();
}

export const explorer = (page: Page) => page.getByRole('region', { name: 'Files' });

export function leafOf(path: string): RegExp {
  const leaf = path.split('/').pop() ?? path;
  return new RegExp(leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

export async function newFile(page: Page, name: string): Promise<void> {
  await explorer(page).getByRole('button', { name: 'New file' }).click();
  await page.getByLabel(/New file name/).fill(name);
  await page.getByLabel(/New file name/).press('Enter');
  await expect(page.getByRole('treeitem', { name: leafOf(name) })).toBeVisible();
}

export async function openFile(page: Page, name: string): Promise<void> {
  await page.getByRole('treeitem', { name: new RegExp(name.split('.')[0]!) }).click();
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 });
}

export async function editorText(page: Page): Promise<string> {
  const painted = (await page.locator('.monaco-editor .view-lines').first().textContent()) ?? '';
  return painted.replaceAll(String.fromCharCode(0x00a0), ' ');
}
