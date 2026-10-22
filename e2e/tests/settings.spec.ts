import { expect, test } from '@playwright/test';
import { createProject, signUp } from './helpers.js';

test.describe('project settings', () => {
  test('delete a project and it is gone', async ({ page }) => {
    await signUp(page);
    await createProject(page, 'Temporary');

    await page.getByRole('link', { name: /Temporary/ }).click();
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(page.getByRole('heading', { name: 'Temporary' })).toBeVisible();

    await page.getByRole('button', { name: 'Delete project' }).click();
    const confirm = page.getByRole('button', { name: /Yes, delete Temporary/ });
    await expect(confirm).toBeDisabled();
    await page.getByLabel(/Type .* to confirm/).fill('Temporary');
    await confirm.click();

    await expect(page.getByText('Nothing here yet')).toBeVisible();
    await page.reload();
    await expect(page.getByText('Nothing here yet')).toBeVisible();
  });

  test('every settings page keeps the project name as its heading', async ({ page }) => {
    await signUp(page);
    await createProject(page, 'Navigable');

    await page.getByRole('link', { name: /Navigable/ }).click();
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Navigable' })).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Project settings' });
    for (const label of ['People', 'Environment', 'Deploy', 'History', 'Monitoring', 'Logs']) {
      await nav.getByRole('link', { name: label }).click();
      await expect(page).toHaveURL(new RegExp(`/settings/${label.toLowerCase()}$`));
      await expect(page.getByRole('heading', { level: 1, name: 'Navigable' })).toBeVisible();
    }
  });
});
