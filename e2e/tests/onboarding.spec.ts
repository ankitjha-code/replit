import { expect, test, type Page } from '@playwright/test';
import { createProject, signUp } from './helpers.js';

/**
 * What a brand-new account is shown, and what a starter template does,
 * through a real browser against the real API.
 *
 * The checklist derives its state from the server (projects, environment
 * history, run state) and from this browser (preview opened), so these tests
 * read the same things a person would see rather than any stored flag.
 */

const checklist = (page: Page) => page.getByRole('region', { name: 'Getting started' });

test.describe('onboarding', () => {
  test('a new account sees the checklist, the starters and the verify-email note', async ({
    page,
  }) => {
    await signUp(page);

    await expect(page.getByRole('heading', { name: 'Getting started' })).toBeVisible();
    await expect(checklist(page).getByRole('meter', { name: 'Steps done' })).toHaveAttribute(
      'aria-valuetext',
      '0 of 5',
    );
    await expect(checklist(page).getByRole('listitem')).toHaveCount(5);

    await expect(page.getByText('Nothing here yet')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Or start from a template' })).toBeVisible();
    // Asked once, as a checklist step; the separate banner stays away while
    // the checklist is on screen so the same request is not made twice.
    await expect(checklist(page).getByText('Confirm your email')).toBeVisible();
    await expect(
      page.getByText('Confirm your email so password resets and alerts can reach you.'),
    ).toHaveCount(0);

    // The usage card is there before any limit is hit, so the ceiling is known in advance.
    await expect(page.getByRole('meter', { name: 'Environments running' })).toHaveAttribute(
      'aria-valuetext',
      /^0 of \d+$/,
    );
  });

  test('hiding the checklist is remembered for this account', async ({ page }) => {
    await signUp(page);
    await expect(page.getByRole('heading', { name: 'Getting started' })).toBeVisible();

    await checklist(page).getByRole('button', { name: 'Hide' }).click();
    await expect(page.getByRole('heading', { name: 'Getting started' })).toHaveCount(0);

    await page.reload();
    await expect(page.getByText('Nothing here yet')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Getting started' })).toHaveCount(0);
  });

  test('a Blank project stays on the list and ticks the first step', async ({ page }) => {
    await signUp(page);
    await createProject(page, 'Plain');

    await expect(page.getByRole('link', { name: /Plain/ })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await expect(checklist(page).getByRole('meter', { name: 'Steps done' })).toHaveAttribute(
      'aria-valuetext',
      '1 of 5',
    );
    // The next step points at the project just made; the card stays the only
    // link named after it, which is what the shared helpers click.
    const card = page.getByRole('link', { name: /Plain/ });
    await expect(card).toHaveCount(1);
    await expect(checklist(page).getByRole('link', { name: 'Open the workspace' })).toHaveAttribute(
      'href',
      (await card.getAttribute('href')) ?? '',
    );
  });

  test('a Node.js starter writes its files, saves the run command and opens the workspace', async ({
    page,
  }) => {
    await signUp(page);
    await page.getByRole('button', { name: 'Create your first project' }).click();

    const dialog = page.getByRole('dialog', { name: 'New project' });
    await dialog.getByRole('radio', { name: /Node\.js 22/ }).click();
    await expect(dialog.getByRole('radio', { name: /Node\.js 22/ })).toBeChecked();
    await dialog.getByLabel('Project name').fill('Engine');
    await dialog.getByRole('button', { name: 'Create project' }).click();

    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/, { timeout: 15_000 });
    const projectId = page.url().split('/projects/')[1]!;
    await expect(page.getByRole('region', { name: 'Files' })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /package\.json/ })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /index\.js/ })).toBeVisible();

    // The files are real, through the ordinary files API, and the command is saved.
    const tree = await page.request.get(`/api/projects/${projectId}/files`);
    expect(tree.ok()).toBe(true);
    const paths = ((await tree.json()) as { entries: Array<{ path: string }> }).entries.map(
      (entry) => entry.path,
    );
    expect(paths).toEqual(
      expect.arrayContaining(['package.json', 'index.js', 'README.md', '.gitignore']),
    );

    const run = await page.request.get(`/api/projects/${projectId}/runtime/run`);
    expect(run.ok()).toBe(true);
    expect(((await run.json()) as { configuredCommand: string | null }).configuredCommand).toBe(
      'npm start',
    );
  });

  test('a starter tile on the home opens the dialog with that template chosen', async ({
    page,
  }) => {
    await signUp(page);
    await page.getByRole('button', { name: /^Python 3\.12/ }).click();

    const dialog = page.getByRole('dialog', { name: 'New project' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio', { name: /Python 3\.12/ })).toBeChecked();
    await expect(dialog.getByLabel('Project name')).toBeFocused();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('the second project is "New project", and the dialog opens on Blank', async ({ page }) => {
    await signUp(page);
    await createProject(page, 'First');
    await expect(page.getByRole('link', { name: /First/ })).toBeVisible();

    await page.getByRole('button', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog', { name: 'New project' });
    await expect(dialog.getByRole('radio', { name: /Blank/ })).toBeChecked();
    await dialog.getByLabel('Project name').fill('Second');
    await dialog.getByRole('button', { name: 'Create project' }).click();

    await expect(page.getByRole('link', { name: /Second/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /First/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Getting started' })).toBeVisible();
  });
});
