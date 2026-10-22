import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  openShell,
  openWorkspace,
  signUp,
  startRuntime,
  stopRuntime,
  writeFile,
} from './helpers.js';

/**
 * Light and dark, as a person meets them.
 *
 * Runs in the `light` project only (playwright.config.ts), whose browser
 * prefers the light scheme, so the first assertion of each test is what a
 * light-preferring system shows before anyone chooses anything.
 */

/** The relative luminance of a computed `rgb()`/`rgba()` colour, 0 (black) to 1 (white). */
function luminance(colour: string): number {
  const channels = colour
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number);
  if (!channels || channels.length < 3) throw new Error(`Not a colour: ${colour}`);
  const [r, g, b] = channels.map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

async function background(target: Locator): Promise<number> {
  return luminance(await target.evaluate((element) => getComputedStyle(element).backgroundColor));
}

const pageBackground = (page: Page) => background(page.locator('body'));

async function expectLight(target: () => Promise<number>): Promise<void> {
  await expect.poll(target).toBeGreaterThan(0.6);
}

async function expectDark(target: () => Promise<number>): Promise<void> {
  await expect.poll(target).toBeLessThan(0.1);
}

/** Picks a theme from the account menu, the one place it is chosen. */
async function chooseTheme(page: Page, label: 'System' | 'Dark' | 'Light'): Promise<void> {
  await page.locator('.account-menu__trigger').click();
  await page.getByRole('menuitemcheckbox', { name: label }).click();
}

test.describe('the theme', () => {
  test('follows the system preference until one is chosen', async ({ page }) => {
    await page.goto('/');
    await expectLight(() => pageBackground(page));
    // Nothing stored, nothing forced: the media query decides.
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);

    await page.emulateMedia({ colorScheme: 'dark' });
    await expectDark(() => pageBackground(page));

    await page.emulateMedia({ colorScheme: 'light' });
    await expectLight(() => pageBackground(page));
  });

  test('the account menu choice wins over the system and survives a reload', async ({ page }) => {
    await signUp(page);
    await expectLight(() => pageBackground(page));

    await chooseTheme(page, 'Dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expectDark(() => pageBackground(page));

    await page.reload();
    await expectDark(() => pageBackground(page));
    await page.locator('.account-menu__trigger').click();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Dark' })).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();

    await chooseTheme(page, 'System');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    await expectLight(() => pageBackground(page));
  });

  test('the editor and the terminal change with it', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await openWorkspace(page, 'Two Themes');
    await writeFile(page, projectId, 'index.html', '<h1>both themes</h1>');
    await page.getByRole('treeitem', { name: /index\.html/ }).click();
    const editor = page.locator('.monaco-editor').first();
    await expect(editor).toBeVisible({ timeout: 30_000 });

    await startRuntime(page);
    await openShell(page);
    const terminal = page.locator('.xterm-viewport').first();
    await expect(terminal).toBeVisible({ timeout: 30_000 });

    await expectLight(() => background(editor));
    await expectLight(() => background(terminal));

    await chooseTheme(page, 'Dark');
    await expectDark(() => background(editor));
    await expectDark(() => background(terminal));

    await chooseTheme(page, 'Light');
    await expectLight(() => background(editor));
    await expectLight(() => background(terminal));

    await stopRuntime(page, projectId);
  });
});
