import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectSignedIn, uniqueIdentity } from './helpers.js';

async function expectVisibleFocus(target: Locator): Promise<void> {
  await expect(target).toBeFocused();
  const ring = await target.evaluate((element) => {
    const drawn = (node: Element): boolean => {
      const style = getComputedStyle(node);
      const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
      return outline || (style.boxShadow !== 'none' && style.boxShadow !== '');
    };
    if (!element.matches(':focus-visible')) return 'focused, but not as keyboard focus';
    if (drawn(element)) return 'ring';
    const wrapper = element.closest('.ui-input-wrap');
    return wrapper && drawn(wrapper) ? 'ring' : 'no ring';
  });
  expect(ring).toBe('ring');
}

async function tabTo(page: Page, target: Locator, max = 40): Promise<void> {
  await expect(target).toBeVisible();
  for (let presses = 0; presses < max; presses++) {
    if (await target.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expectVisibleFocus(target);
}

test('sign up, start a Node.js starter, run it, preview it and reach Deploy, by keyboard', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const identity = uniqueIdentity();

  await page.goto('/register');
  await tabTo(page, page.getByLabel('Email', { exact: true }));
  await page.keyboard.type(identity.email);
  await tabTo(page, page.getByLabel('Username', { exact: true }));
  await page.keyboard.type(identity.username);
  await tabTo(page, page.getByLabel('Password', { exact: true }));
  await page.keyboard.type(identity.password);
  await page.keyboard.press('Enter');
  await expectSignedIn(page);

  await tabTo(page, page.getByRole('button', { name: /^Node\.js 22/ }));
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await expect(dialog.getByRole('radio', { name: /Node\.js 22/ })).toBeChecked();
  await expectVisibleFocus(dialog.getByLabel('Project name'));
  await page.keyboard.type('Keyboard Only');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/, { timeout: 15_000 });
  const projectId = page.url().split('/projects/')[1]!;

  await expect(page.locator('.runtime-chip')).not.toHaveText(/Checking/, { timeout: 30_000 });
  await tabTo(page, page.getByRole('button', { name: 'Start', exact: true }));
  await page.keyboard.press('Enter');
  await expect(page.locator('.runtime-chip')).toHaveText('Running', { timeout: 280_000 });

  try {
    const guide = page.getByRole('status', { name: 'Getting started' });
    await expect(guide).toContainText('Press Run');
    await tabTo(page, guide.getByRole('button', { name: 'Show me' }));
    await page.keyboard.press('Enter');
    const consoleRegion = page.getByRole('region', { name: 'Console' });
    const run = consoleRegion.getByRole('button', { name: 'Run', exact: true });
    await expectVisibleFocus(run);
    await page.keyboard.press('Enter');
    await expect(consoleRegion.getByText(/Listening on/)).toBeVisible({ timeout: 60_000 });

    const preview = page.getByRole('region', { name: 'Preview' });
    const openInTab = preview.getByRole('link', { name: 'Open in a tab' }).first();
    await expect(openInTab).toBeVisible({ timeout: 60_000 });
    await tabTo(page, openInTab, 80);
    const [tab] = await Promise.all([page.waitForEvent('popup'), page.keyboard.press('Enter')]);
    await tab.waitForLoadState();
    await expect(tab.locator('body')).toContainText('Keyboard Only');
    await tab.close();

    await page.bringToFront();
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog');
    await expect(palette.getByRole('combobox')).toBeFocused();
    await page.keyboard.type('Settings: Deploy');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/settings/deploy$`));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await tabTo(page, page.getByRole('link', { name: 'Deploy', exact: true }), 60);
  } finally {
    await page.request.post(`/api/projects/${projectId}/runtime/stop`, { data: {} });
  }
});
