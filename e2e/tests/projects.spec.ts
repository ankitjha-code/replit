import { expect, test } from '@playwright/test';
import { createProject, signOut, signUp } from './helpers.js';

/**
 * Creating and managing projects through a real browser, against the real API
 * and database.
 *
 * Each run signs up a fresh account so the suite is repeatable without a reset
 * step, and so one run's projects cannot make another's assertions pass.
 */

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
    // Exact: the create dialog's hint "Opens at /my-first-project" may still be fading out.
    await expect(page.getByText('/my-first-project', { exact: true })).toBeVisible();

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

  test('shows the URL it will use before creating', async ({ page }) => {
    await signUp(page);
    await page.getByRole('button', { name: 'Create your first project' }).click();
    await page.getByLabel('Project name').fill('Café Résumé');

    // The browser and the server derive the slug with the same function, so
    // the preview is a promise the server keeps.
    await expect(page.getByText('Opens at /cafe-resume')).toBeVisible();
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

    await signOut(page);
    await expect(page.getByRole('heading', { name: /Build and run applications/ })).toBeVisible();
    await expect(page.getByText('Hidden After Sign Out')).toHaveCount(0);
  });
});
