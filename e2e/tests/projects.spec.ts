import { expect, test, type Page } from '@playwright/test';

/**
 * Creating and managing projects through a real browser, against the real API
 * and database.
 *
 * Each run signs up a fresh account so the suite is repeatable without a reset
 * step, and so one run's projects cannot make another's assertions pass.
 */

function uniqueIdentity() {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    email: `e2e-${suffix}@example.test`,
    username: `e2e-${suffix}`,
    password: 'analytical-engine-1843',
  };
}

/** Signs up and waits until the browser is actually signed in. */
async function signUp(page: Page): Promise<void> {
  const identity = uniqueIdentity();
  await page.goto('/register');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Username').fill(identity.username);
  await page.getByLabel('Password').fill(identity.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function createProject(page: Page, name: string): Promise<void> {
  const start = page.getByRole('button', { name: 'Create your first project' });
  if (await start.isVisible().catch(() => false)) {
    await start.click();
  } else {
    await page.getByRole('button', { name: 'New project' }).click();
  }

  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
}

test.describe('projects', () => {
  test('a signed-out visitor is invited to sign up rather than bounced', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Build and run applications/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create an account' })).toBeVisible();
  });

  test('a new account starts with no projects', async ({ page }) => {
    await signUp(page);
    await expect(page.getByText('Nothing here yet')).toBeVisible();
  });

  test('create a project, see it listed, open it', async ({ page }) => {
    await signUp(page);
    await createProject(page, 'My First Project');

    await expect(page.getByText('My First Project')).toBeVisible();
    await expect(page.getByText('/my-first-project')).toBeVisible();

    await page.getByRole('link', { name: /My First Project/ }).click();
    // Opening a project puts you in front of the workspace, not a form.
    await expect(page.getByRole('region', { name: 'Editor' })).toBeVisible();
    await expect(page.getByText('My First Project', { exact: true })).toBeVisible();
  });

  test('the project survives a reload', async ({ page }) => {
    await signUp(page);
    // A name whose slug is not a substring of it, so the card's name and its
    // address cannot both match one text query.
    await createProject(page, 'Keeps Going');
    await expect(page.getByText('Keeps Going', { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByText('Keeps Going', { exact: true })).toBeVisible();
  });

  test('shows the address it will use before creating', async ({ page }) => {
    await signUp(page);
    await page.getByRole('button', { name: 'Create your first project' }).click();
    await page.getByLabel('Project name').fill('Café Résumé');

    // The browser and the server derive the slug with the same function, so
    // the preview is a promise the server keeps.
    await expect(page.getByText('Its address will be /cafe-resume')).toBeVisible();
  });

  test('numbers the address when the name is reused', async ({ page }) => {
    await signUp(page);
    await createProject(page, 'Twice');
    await expect(page.getByText('/twice')).toBeVisible();

    await createProject(page, 'Twice');
    await expect(page.getByText('/twice-2')).toBeVisible();
  });

  test('refuses an empty name without contacting the server', async ({ page }) => {
    await signUp(page);

    let requested = false;
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() === 'POST') requested = true;
      await route.continue();
    });

    await page.getByRole('button', { name: 'Create your first project' }).click();
    await page.getByRole('button', { name: 'Create project' }).click();

    await expect(page.getByText('Enter a name')).toBeVisible();
    expect(requested).toBe(false);
  });

  test('delete a project and it is gone', async ({ page }) => {
    await signUp(page);
    await createProject(page, 'Temporary');

    await page.getByRole('link', { name: /Temporary/ }).click();
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Temporary' })).toBeVisible();

    await page.getByRole('button', { name: 'Delete project' }).click();
    await page.getByRole('button', { name: /Yes, delete Temporary/ }).click();

    await expect(page.getByText('Nothing here yet')).toBeVisible();
    await page.reload();
    await expect(page.getByText('Nothing here yet')).toBeVisible();
  });

  test('one account cannot open another account project', async ({ page, browser }) => {
    await signUp(page);
    await createProject(page, 'Private Work');
    await page.getByRole('link', { name: /Private Work/ }).click();
    const projectUrl = page.url();

    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signUp(otherPage);
    await otherPage.goto(projectUrl);

    // The same wording as a project that does not exist: the server does not
    // distinguish the two.
    await expect(otherPage.getByRole('heading', { name: 'Not found' })).toBeVisible();

    await other.close();
  });

  test('the project list only ever holds the caller own projects', async ({ page, browser }) => {
    await signUp(page);
    await createProject(page, 'Mine Alone');

    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signUp(otherPage);

    await expect(otherPage.getByText('Nothing here yet')).toBeVisible();
    await expect(otherPage.getByText('Mine Alone')).toHaveCount(0);

    await other.close();
  });

  test('projects are refused to an anonymous caller at the API', async ({ request }) => {
    const response = await request.get('/api/projects', { failOnStatusCode: false });
    expect(response.status()).toBe(401);
  });

  test('signing out hides the project list', async ({ page }) => {
    await signUp(page);
    await createProject(page, 'Hidden After Sign Out');
    await expect(page.getByText('Hidden After Sign Out')).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: /Build and run applications/ })).toBeVisible();
    await expect(page.getByText('Hidden After Sign Out')).toHaveCount(0);
  });
});
