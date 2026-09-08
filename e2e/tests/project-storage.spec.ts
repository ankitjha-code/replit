import { expect, test, type Page } from '@playwright/test';

/**
 * A project's files and its secrets, in a real browser.
 *
 * The two live side by side in settings and behave oppositely in the way that
 * matters: an asset can be downloaded again, and a secret can never be read
 * back by anyone, including the person who set it.
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

/** Signs up, makes a project, and opens its settings. */
async function openSettings(page: Page, name = 'Storage Test'): Promise<string> {
  await signUp(page);
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await expect(page.getByRole('region', { name: 'Files' })).toBeVisible();

  const projectId = page.url().split('/projects/')[1]!;
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Files' })).toBeVisible();

  return projectId;
}

async function upload(page: Page, name: string, contents: string, mimeType = 'text/plain') {
  await page.getByLabel('Upload a file').setInputFiles({
    name,
    mimeType,
    buffer: Buffer.from(contents),
  });
}

test.describe('project files', () => {
  test('uploads a file and lists it', async ({ page }) => {
    await openSettings(page);
    await expect(page.getByText('No files yet.')).toBeVisible();

    await upload(page, 'notes.txt', 'some notes');

    await expect(page.getByText('notes.txt')).toBeVisible({ timeout: 30_000 });
  });

  test('downloads the same bytes back', async ({ page }) => {
    const projectId = await openSettings(page);
    await upload(page, 'data.csv', 'a,b,c\n1,2,3\n');
    await expect(page.getByText('data.csv')).toBeVisible({ timeout: 30_000 });

    const listed = await (await page.request.get(`/api/projects/${projectId}/assets`)).json();
    const response = await page.request.get(
      `/api/projects/${projectId}/assets/${listed.assets[0].id}/content`,
    );

    expect(await response.text()).toBe('a,b,c\n1,2,3\n');
  });

  test('never lets an uploaded page run on the platform origin', async ({ page }) => {
    // A file claiming to be one thing and containing a page would otherwise
    // run as whoever opened it, with their session.
    const projectId = await openSettings(page);
    await upload(page, 'trap.html', '<script>alert(1)</script>', 'text/html');
    await expect(page.getByText('trap.html')).toBeVisible({ timeout: 30_000 });

    const listed = await (await page.request.get(`/api/projects/${projectId}/assets`)).json();
    const response = await page.request.get(
      `/api/projects/${projectId}/assets/${listed.assets[0].id}/content`,
    );

    expect(response.headers()['content-type']).toBe('application/octet-stream');
    expect(response.headers()['content-disposition']).toContain('attachment');
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('removes a file', async ({ page }) => {
    await openSettings(page);
    await upload(page, 'temporary.txt', 'x');
    await expect(page.getByText('temporary.txt')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Remove' }).first().click();

    await expect(page.getByText('No files yet.')).toBeVisible({ timeout: 30_000 });
  });

  test('keeps one account files away from another', async ({ page }) => {
    const projectId = await openSettings(page);
    await upload(page, 'private.txt', 'x');
    await expect(page.getByText('private.txt')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Sign out' }).click();
    await signUp(page);

    const response = await page.request.get(`/api/projects/${projectId}/assets`);
    expect(response.status()).toBe(404);
  });
});

test.describe('project secrets', () => {
  test('stores one and shows only its name', async ({ page }) => {
    await openSettings(page);

    await page.getByLabel('Name', { exact: true }).fill('API_TOKEN');
    await page.getByLabel('Value', { exact: true }).fill('sk-live-do-not-leak');
    await page.getByRole('button', { name: 'Save secret' }).click();

    await expect(page.getByText('API_TOKEN')).toBeVisible({ timeout: 30_000 });
    // Nowhere on the page, in any form.
    await expect(page.getByText('sk-live-do-not-leak')).toHaveCount(0);
  });

  test('the value is never returned by the API either', async ({ page }) => {
    const projectId = await openSettings(page);

    await page.getByLabel('Name', { exact: true }).fill('API_TOKEN');
    await page.getByLabel('Value', { exact: true }).fill('sk-live-do-not-leak');
    await page.getByRole('button', { name: 'Save secret' }).click();
    await expect(page.getByText('API_TOKEN')).toBeVisible({ timeout: 30_000 });

    const body = await (await page.request.get(`/api/projects/${projectId}/secrets`)).text();
    expect(body).toContain('API_TOKEN');
    expect(body).not.toContain('sk-live');
  });

  test('clears the value from the form once it is sent', async ({ page }) => {
    await openSettings(page);

    await page.getByLabel('Name', { exact: true }).fill('API_TOKEN');
    const value = page.getByLabel('Value', { exact: true });
    await value.fill('sk-live-abc');
    await page.getByRole('button', { name: 'Save secret' }).click();

    await expect(value).toHaveValue('', { timeout: 30_000 });
  });

  test('refuses a name that would change how the runtime loads code', async ({ page }) => {
    await openSettings(page);

    await page.getByLabel('Name', { exact: true }).fill('PATH');
    await page.getByLabel('Value', { exact: true }).fill('/tmp/evil');
    await page.getByRole('button', { name: 'Save secret' }).click();

    await expect(page.getByRole('alert')).toContainText('reserved', { timeout: 30_000 });
  });

  test('removes one', async ({ page }) => {
    await openSettings(page);
    await page.getByLabel('Name', { exact: true }).fill('API_TOKEN');
    await page.getByLabel('Value', { exact: true }).fill('sk-live-abc');
    await page.getByRole('button', { name: 'Save secret' }).click();
    await expect(page.getByText('API_TOKEN')).toBeVisible({ timeout: 30_000 });

    await page
      .getByRole('listitem')
      .filter({ hasText: 'API_TOKEN' })
      .getByRole('button', { name: 'Remove' })
      .click();

    await expect(page.getByText('No secrets yet.')).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('environment variables', () => {
  test('sets one and shows its value, unlike a secret', async ({ page }) => {
    await openSettings(page);
    await expect(page.getByText('No environment variables yet.')).toBeVisible();

    await page.getByLabel('Variable name').fill('LOG_LEVEL');
    await page.getByLabel('Variable value').fill('debug');
    await page.getByRole('button', { name: 'Save variable' }).click();

    // The value on the page, which is the entire point of the feature and the
    // exact thing the secrets panel below refuses to do.
    await expect(page.getByText('LOG_LEVEL', { exact: true })).toBeVisible();
    await expect(page.getByText('debug', { exact: true })).toBeVisible();
  });

  test('the value really comes back from the API, not just the form', async ({ page }) => {
    const projectId = await openSettings(page);

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
    await openSettings(page);

    await page.getByLabel('Variable name').fill('REGION');
    await page.getByLabel('Variable value').fill('eu-west');
    await page.getByRole('button', { name: 'Save variable' }).click();
    await expect(page.getByText('eu-west', { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByText('eu-west', { exact: true })).toBeVisible();
  });

  test('editing one starts from its current value', async ({ page }) => {
    // Starting from empty would mean overwriting blind, which is the failing
    // of the secrets form and only acceptable there because it must be.
    await openSettings(page);

    await page.getByLabel('Variable name').fill('PORT');
    await page.getByLabel('Variable value').fill('8080');
    await page.getByRole('button', { name: 'Save variable' }).click();
    await expect(page.getByText('8080', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByLabel('Variable name')).toHaveValue('PORT');
    await expect(page.getByLabel('Variable value')).toHaveValue('8080');

    await page.getByLabel('Variable value').fill('9090');
    await page.getByRole('button', { name: 'Save variable' }).click();
    await expect(page.getByText('9090', { exact: true })).toBeVisible();
    await expect(page.getByText('8080', { exact: true })).toBeHidden();
  });

  test('refuses a name a shell could not use, and says which rule', async ({ page }) => {
    await openSettings(page);

    // The form upper-cases as it goes, so a dash is what is left to reject.
    await page.getByLabel('Variable name').fill('NOT-A-NAME');
    await page.getByLabel('Variable value').fill('x');
    await page.getByRole('button', { name: 'Save variable' }).click();

    await expect(page.getByRole('alert')).toContainText(/capital letters/i);
  });

  test('refuses a name a secret already uses', async ({ page }) => {
    await openSettings(page);

    await page.getByLabel('Name', { exact: true }).fill('DATABASE_URL');
    await page.getByLabel('Value', { exact: true }).fill('postgres://real');
    await page.getByRole('button', { name: 'Save secret' }).click();
    await expect(page.getByText('DATABASE_URL', { exact: true })).toBeVisible();

    await page.getByLabel('Variable name').fill('DATABASE_URL');
    await page.getByLabel('Variable value').fill('postgres://fake');
    await page.getByRole('button', { name: 'Save variable' }).click();

    await expect(page.getByRole('alert')).toContainText(/already used by a secret/i);
  });

  test('removes one', async ({ page }) => {
    await openSettings(page);

    await page.getByLabel('Variable name').fill('TEMPORARY');
    await page.getByLabel('Variable value').fill('yes');
    await page.getByRole('button', { name: 'Save variable' }).click();
    await expect(page.getByText('TEMPORARY', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Remove', exact: true }).first().click();
    await expect(page.getByText('No environment variables yet.')).toBeVisible();
  });

  test('keeps one account variables away from another', async ({ page }) => {
    const projectId = await openSettings(page);
    await page.getByLabel('Variable name').fill('SECRETISH');
    await page.getByLabel('Variable value').fill('not-yours');
    await page.getByRole('button', { name: 'Save variable' }).click();
    await expect(page.getByText('not-yours', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await signUp(page);

    const response = await page.request.get(`/api/projects/${projectId}/variables`);
    expect(response.status()).toBe(404);
  });
});
