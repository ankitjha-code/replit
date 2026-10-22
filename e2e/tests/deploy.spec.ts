import { expect, test, type Page } from '@playwright/test';
import { createProject, signUp } from './helpers.js';

/**
 * The Deploy group of settings, through a real browser: the Deploy page's
 * one primary action and its empty state, preview links made and revoked
 * with a confirm, and the Activity table.
 *
 * Nothing here deploys. A build needs the execution backend and takes
 * minutes; the states around it are covered by the component tests with the
 * API scripted.
 */

async function openSettingsPage(page: Page, name: string, label: string): Promise<void> {
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await page
    .getByRole('navigation', { name: 'Project settings' })
    .getByRole('link', { name: label })
    .click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

test.describe('deploy group', () => {
  test('the Deploy page shows one Deploy action and says nothing is deployed yet', async ({
    page,
  }) => {
    await signUp(page);
    await createProject(page, 'Shippable');
    await openSettingsPage(page, 'Shippable', 'Deploy');
    await expect(page).toHaveURL(/\/settings\/deploy$/);

    await expect(page.getByRole('heading', { level: 2, name: 'Deployments' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deploy', exact: true })).toBeVisible();
    await expect(page.getByText('Nothing has been deployed yet.')).toBeVisible();
    await expect(page.getByLabel('Deployment type')).toBeVisible();

    // Saving the configuration on its own is a secondary action with a reason while nothing changed.
    const save = page.getByRole('button', { name: 'Save without deploying' });
    await expect(save).toBeVisible();

    // Domains cannot be set before the first deploy assigns the subdomain.
    await expect(page.getByRole('heading', { level: 2, name: 'Domains' })).toBeVisible();
    await expect(
      page.getByText('Your platform subdomain is assigned on the first deploy.'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to Deployments' })).toBeVisible();
  });

  test('a preview link is shown once and revoked after a confirm', async ({ page }) => {
    await signUp(page);
    await createProject(page, 'Shareable');
    await openSettingsPage(page, 'Shareable', 'People');

    await expect(page.getByRole('heading', { level: 2, name: 'Preview links' })).toBeVisible();
    await expect(page.getByText('No active preview links.')).toBeVisible();

    await page.getByLabel('Works for').selectOption({ label: '1 hour' });
    await page.getByLabel('Note (optional)').fill('For the client');
    await page.getByRole('button', { name: 'Make link' }).click();

    const link = page.getByLabel('New share link');
    await expect(link).toBeVisible();
    await expect(link).toHaveValue(/share=/);
    await expect(page.getByText('Copy this now. It will not be shown again.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy preview link' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'For the client', exact: true })).toBeVisible();

    // Revoking ends every viewing, so it asks first.
    await page.getByRole('button', { name: 'Revoke link for For the client' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Revoke this link?' });
    await expect(dialog.getByText('Anyone using it loses access now.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Revoke link for For the client' }).click();

    await expect(page.getByText('No active preview links.')).toBeVisible();
    await page.reload();
    await expect(page.getByText('No active preview links.')).toBeVisible();
  });

  test('Activity lists platform work for the project', async ({ page }) => {
    await signUp(page);
    await createProject(page, 'Observed');
    await openSettingsPage(page, 'Observed', 'Monitoring');

    await expect(page.getByRole('heading', { level: 2, name: 'Activity' })).toBeVisible();
    // A fresh project has asked the platform for nothing yet.
    await expect(page.getByText('Nothing in progress.')).toBeVisible();
  });
});
