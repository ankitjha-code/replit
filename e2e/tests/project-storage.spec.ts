import { expect, test, type Page } from '@playwright/test';
import { openWorkspace, signOut, signUp } from './helpers.js';

type SettingsPage = 'assets' | 'environment';

async function openSettings(
  page: Page,
  section: SettingsPage,
  name = 'Storage Test',
): Promise<string> {
  const projectId = await openWorkspace(page, name);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await page
    .getByRole('navigation', { name: 'Project settings' })
    .getByRole('link', { name: section === 'assets' ? 'Assets' : 'Environment' })
    .click();
  await expect(
    page.getByRole('heading', {
      level: 2,
      name: section === 'assets' ? 'Assets' : 'Environment variables',
    }),
  ).toBeVisible();

  return projectId;
}

async function upload(page: Page, name: string, contents: string, mimeType = 'text/plain') {
  await page.getByLabel('Upload a file').setInputFiles({
    name,
    mimeType,
    buffer: Buffer.from(contents),
  });
}

const assetsTable = (page: Page) => page.getByRole('table', { name: 'Assets' });

async function confirm(page: Page, label: string): Promise<void> {
  await page.getByRole('alertdialog').getByRole('button', { name: label }).click();
}

test.describe('project assets', () => {
  test('uploads a file and lists it', async ({ page }) => {
    await openSettings(page, 'assets');
    await expect(page.getByText('No assets yet.')).toBeVisible();

    await upload(page, 'notes.txt', 'some notes');

    await expect(assetsTable(page).getByText('notes.txt', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  });

  test('downloads the same bytes back', async ({ page }) => {
    const projectId = await openSettings(page, 'assets');
    await upload(page, 'data.csv', 'a,b,c\n1,2,3\n');
    await expect(assetsTable(page).getByText('data.csv', { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    const listed = await (await page.request.get(`/api/projects/${projectId}/assets`)).json();
    const response = await page.request.get(
      `/api/projects/${projectId}/assets/${listed.assets[0].id}/content`,
    );

    expect(await response.text()).toBe('a,b,c\n1,2,3\n');
  });

  test('never lets an uploaded page run on the platform origin', async ({ page }) => {
    const projectId = await openSettings(page, 'assets');
    await upload(page, 'trap.html', '<script>alert(1)</script>', 'text/html');
    await expect(assetsTable(page).getByText('trap.html', { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    const listed = await (await page.request.get(`/api/projects/${projectId}/assets`)).json();
    const response = await page.request.get(
      `/api/projects/${projectId}/assets/${listed.assets[0].id}/content`,
    );

    expect(response.headers()['content-type']).toBe('application/octet-stream');
    expect(response.headers()['content-disposition']).toContain('attachment');
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('removes a file, after asking', async ({ page }) => {
    await openSettings(page, 'assets');
    await upload(page, 'temporary.txt', 'x');
    await expect(assetsTable(page).getByText('temporary.txt', { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole('button', { name: 'Remove temporary.txt' }).click();
    await confirm(page, 'Remove temporary.txt');

    await expect(page.getByText('No assets yet.')).toBeVisible({ timeout: 30_000 });
  });

  test('keeps one account files away from another', async ({ page }) => {
    const projectId = await openSettings(page, 'assets');
    await upload(page, 'private.txt', 'x');
    await expect(assetsTable(page).getByText('private.txt', { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    await signOut(page);
    await signUp(page);

    const response = await page.request.get(`/api/projects/${projectId}/assets`);
    expect(response.status()).toBe(404);
  });
});

test.describe('project secrets', () => {
  test('stores one and shows only its name', async ({ page }) => {
    await openSettings(page, 'environment');

    await page.getByLabel('Name', { exact: true }).fill('API_TOKEN');
    await page.getByLabel('Value', { exact: true }).fill('sk-live-do-not-leak');
    await page.getByRole('button', { name: 'Save secret' }).click();

    await expect(page.getByText('API_TOKEN', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('sk-live-do-not-leak')).toHaveCount(0);
  });

  test('the value is never returned by the API either', async ({ page }) => {
    const projectId = await openSettings(page, 'environment');

    await page.getByLabel('Name', { exact: true }).fill('API_TOKEN');
    await page.getByLabel('Value', { exact: true }).fill('sk-live-do-not-leak');
    await page.getByRole('button', { name: 'Save secret' }).click();
    await expect(page.getByText('API_TOKEN', { exact: true })).toBeVisible({ timeout: 30_000 });

    const body = await (await page.request.get(`/api/projects/${projectId}/secrets`)).text();
    expect(body).toContain('API_TOKEN');
    expect(body).not.toContain('sk-live');
  });

  test('clears the value from the form once it is sent', async ({ page }) => {
    await openSettings(page, 'environment');

    await page.getByLabel('Name', { exact: true }).fill('API_TOKEN');
    const value = page.getByLabel('Value', { exact: true });
    await value.fill('sk-live-abc');
    await page.getByRole('button', { name: 'Save secret' }).click();

    await expect(value).toHaveValue('', { timeout: 30_000 });
  });

  test('refuses a name that would change how the runtime loads code', async ({ page }) => {
    await openSettings(page, 'environment');

    await page.getByLabel('Name', { exact: true }).fill('PATH');
    await page.getByLabel('Value', { exact: true }).fill('/tmp/evil');
    await page.getByRole('button', { name: 'Save secret' }).click();

    await expect(page.getByRole('alert')).toContainText('reserved', { timeout: 30_000 });
  });

  test('removes one, after asking', async ({ page }) => {
    await openSettings(page, 'environment');
    await page.getByLabel('Name', { exact: true }).fill('API_TOKEN');
    await page.getByLabel('Value', { exact: true }).fill('sk-live-abc');
    await page.getByRole('button', { name: 'Save secret' }).click();
    await expect(page.getByText('API_TOKEN', { exact: true })).toBeVisible({ timeout: 30_000 });

    await page
      .getByRole('listitem')
      .filter({ hasText: 'API_TOKEN' })
      .getByRole('button', { name: 'Remove API_TOKEN' })
      .click();
    await confirm(page, 'Remove API_TOKEN');

    await expect(page.getByText('No secrets yet.')).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('environment variables', () => {
  test('sets one and shows its value, unlike a secret', async ({ page }) => {
    await openSettings(page, 'environment');
    await expect(page.getByText('No environment variables yet.')).toBeVisible();

    await page.getByLabel('Variable name').fill('LOG_LEVEL');
    await page.getByLabel('Variable value').fill('debug');
    await page.getByRole('button', { name: 'Save variable' }).click();

    await expect(page.getByText('LOG_LEVEL', { exact: true })).toBeVisible();
    await expect(page.getByText('debug', { exact: true })).toBeVisible();
  });

  test('the value really comes back from the API, not just the form', async ({ page }) => {
    const projectId = await openSettings(page, 'environment');

    await page.getByLabel('Variable name').fill('PORT');
    await page.getByLabel('Variable value').fill('8080');
    await page.getByRole('button', { name: 'Save variable' }).click();
    await expect(page.getByText('8080', { exact: true })).toBeVisible();

    const response = await page.request.get(`/api/projects/${projectId}/variables`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.variables).toEqual([expect.objectContaining({ key: 'PORT', value: '8080' })]);
  });

  test('survives a reload, because it is on the server', async ({ page }) => {
    await openSettings(page, 'environment');

    await page.getByLabel('Variable name').fill('REGION');
    await page.getByLabel('Variable value').fill('eu-west');
    await page.getByRole('button', { name: 'Save variable' }).click();
    await expect(page.getByText('eu-west', { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByText('eu-west', { exact: true })).toBeVisible();
  });

  test('editing one starts from its current value, with the name locked', async ({ page }) => {
    await openSettings(page, 'environment');

    await page.getByLabel('Variable name').fill('PORT');
    await page.getByLabel('Variable value').fill('8080');
    await page.getByRole('button', { name: 'Save variable' }).click();
    await expect(page.getByText('8080', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Edit PORT' }).click();
    await expect(page.getByLabel('Variable name')).toHaveValue('PORT');
    await expect(page.getByLabel('Variable name')).toHaveAttribute('readonly', '');
    await expect(page.getByLabel('Variable value')).toHaveValue('8080');

    await page.getByLabel('Variable value').fill('9090');
    await page.getByRole('button', { name: 'Save variable' }).click();
    await expect(page.getByText('9090', { exact: true })).toBeVisible();
    await expect(page.getByText('8080', { exact: true })).toBeHidden();
  });

  test('refuses a name a shell could not use, and says which rule', async ({ page }) => {
    await openSettings(page, 'environment');

    await page.getByLabel('Variable name').fill('NOT-A-NAME');
    await page.getByLabel('Variable value').fill('x');
    await page.getByRole('button', { name: 'Save variable' }).click();

    await expect(page.getByRole('alert')).toContainText(/capital letters/i);
  });

  test('refuses a name a secret already uses', async ({ page }) => {
    await openSettings(page, 'environment');

    await page.getByLabel('Name', { exact: true }).fill('DATABASE_URL');
    await page.getByLabel('Value', { exact: true }).fill('postgres://real');
    await page.getByRole('button', { name: 'Save secret' }).click();
    await expect(page.getByText('DATABASE_URL', { exact: true })).toBeVisible();

    await page.getByLabel('Variable name').fill('DATABASE_URL');
    await page.getByLabel('Variable value').fill('postgres://fake');
    await page.getByRole('button', { name: 'Save variable' }).click();

    await expect(page.getByRole('alert')).toContainText(/already used by a secret/i);
  });

  test('removes one, after asking', async ({ page }) => {
    await openSettings(page, 'environment');

    await page.getByLabel('Variable name').fill('TEMPORARY');
    await page.getByLabel('Variable value').fill('yes');
    await page.getByRole('button', { name: 'Save variable' }).click();
    await expect(page.getByText('TEMPORARY', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Remove TEMPORARY' }).click();
    await confirm(page, 'Remove TEMPORARY');
    await expect(page.getByText('No environment variables yet.')).toBeVisible();
  });

  test('keeps one account variables away from another', async ({ page }) => {
    const projectId = await openSettings(page, 'environment');
    await page.getByLabel('Variable name').fill('SECRETISH');
    await page.getByLabel('Variable value').fill('not-yours');
    await page.getByRole('button', { name: 'Save variable' }).click();
    await expect(page.getByText('not-yours', { exact: true })).toBeVisible();

    await signOut(page);
    await signUp(page);

    const response = await page.request.get(`/api/projects/${projectId}/variables`);
    expect(response.status()).toBe(404);
  });
});
