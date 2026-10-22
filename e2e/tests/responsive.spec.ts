import { expect, test, type Page } from '@playwright/test';
import { createProject, signUp, startRuntime, stopRuntime, writeFile } from './helpers.js';

/**
 * The phone layout, at the 390px width the old layout broke at.
 *
 * Runs in the `phone` project only (playwright.config.ts): a touch device,
 * narrowed to 390x844. What is checked is what used to fail there: Start was
 * painted over, settings inputs collapsed to a couple of characters, and pages
 * scrolled sideways.
 */

const SETTINGS_PAGES = [
  'general',
  'people',
  'environment',
  'database',
  'assets',
  'deploy',
  'history',
  'git',
  'monitoring',
  'logs',
];

const ACCOUNT_PAGES = ['', 'security', 'sessions', 'usage', 'close'];

/** How far the page scrolls sideways; 0 when it fits the screen. */
async function sidewaysScroll(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/**
 * Signs up, creates a project and opens its workspace. Not the shared
 * `openWorkspace`: that waits for the Files region, which a phone keeps
 * hidden until it is chosen in the panel switcher.
 */
async function openPhoneWorkspace(page: Page, name: string): Promise<string> {
  await signUp(page);
  await createProject(page, name);
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await expect(page.getByRole('tablist', { name: 'Workspace panels' })).toBeVisible();
  return page.url().split('/projects/')[1]!;
}

const REGIONS = ['Files', 'Editor', 'Console', 'Preview'];

async function expectNoSidewaysScroll(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  expect(await sidewaysScroll(page), `${path} scrolls sideways`).toBeLessThanOrEqual(0);
}

test.describe('at phone width', () => {
  test('Start is on top of nothing and starts the environment', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await openPhoneWorkspace(page, 'Phone Start');
    await writeFile(page, projectId, 'index.html', '<h1>phone</h1>');

    const start = page.getByRole('button', { name: 'Start', exact: true });
    await expect(start).toBeVisible();
    // A trial click fails when another element would receive the tap, which
    // is exactly how Start used to be lost under "Reset layout".
    await start.click({ trial: true });
    await startRuntime(page);

    await stopRuntime(page, projectId);
  });

  test('the panel switcher shows one region at a time and keeps the others mounted', async ({
    page,
  }) => {
    const projectId = await openPhoneWorkspace(page, 'Phone Panels');
    await writeFile(page, projectId, 'notes.txt', 'kept while switching');

    const switcher = page.getByRole('tablist', { name: 'Workspace panels' });
    await expect(switcher).toBeVisible();

    await switcher.getByRole('tab', { name: 'Files' }).click();
    await page.getByRole('treeitem', { name: /notes\.txt/ }).click();
    // Opening a file shows the editor.
    await expect(switcher.getByRole('tab', { name: 'Editor' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const editor = page.locator('.monaco-editor').first();
    await expect(editor).toBeVisible({ timeout: 30_000 });
    // Marks this exact element; a remount would bring a fresh one without it.
    await editor.evaluate((element) => element.setAttribute('data-phone-probe', 'kept'));

    for (const name of ['Files', 'Console', 'Preview', 'Editor']) {
      await switcher.getByRole('tab', { name }).click();
      await expect(switcher.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('region', { name })).toBeVisible();
      for (const other of REGIONS.filter((region) => region !== name)) {
        // Hidden, not removed: every region stays in the page.
        const region = page.locator(`section[aria-label="${other}"]`);
        await expect(region).toHaveCount(1);
        await expect(region).toBeHidden();
      }
    }

    await expect(page.locator('.monaco-editor[data-phone-probe="kept"]')).toBeVisible();
    expect(await sidewaysScroll(page)).toBeLessThanOrEqual(0);
  });

  test('settings inputs keep a usable width', async ({ page }) => {
    const projectId = await openPhoneWorkspace(page, 'Phone Settings');

    for (const section of SETTINGS_PAGES) {
      await page.goto(`/projects/${projectId}/settings/${section}`);
      await page.waitForLoadState('networkidle');
      const widths = await page
        .locator(
          'main input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="file"]), main select, main textarea',
        )
        .evaluateAll((fields) =>
          fields
            .map((field) => ({
              name:
                field.getAttribute('aria-label') ??
                (field as HTMLInputElement).labels?.[0]?.textContent ??
                field.id,
              width: field.getBoundingClientRect().width,
            }))
            .filter((field) => field.width > 0),
        );
      for (const field of widths) {
        expect(field.width, `${section}: "${field.name}"`).toBeGreaterThanOrEqual(200);
      }
    }
  });

  test('no page scrolls sideways', async ({ page }) => {
    await expectNoSidewaysScroll(page, '/');
    await expectNoSidewaysScroll(page, '/status');

    const projectId = await openPhoneWorkspace(page, 'Phone Width');
    await expectNoSidewaysScroll(page, '/');
    await expectNoSidewaysScroll(page, `/projects/${projectId}`);
    for (const section of SETTINGS_PAGES) {
      await expectNoSidewaysScroll(page, `/projects/${projectId}/settings/${section}`);
    }
    for (const section of ACCOUNT_PAGES) {
      await expectNoSidewaysScroll(page, `/account/${section}`);
    }
    await expectNoSidewaysScroll(page, '/status');
  });
});
