import { expect, test } from '@playwright/test';
import { signUp } from './helpers.js';

/**
 * Baseline journey: the browser loads the shell and it reflects real
 * control-plane state. Feature journeys (register, create project, run,
 * preview, deploy) are added to this suite as those features land.
 */
test.describe('platform baseline', () => {
  test('serves the workspace shell', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: /Build and run applications in the browser/ }),
    ).toBeVisible();
  });

  test('keeps the status page to operators', async ({ page }) => {
    // A visitor is asked to sign in, and a member who is not an operator finds
    // nothing there: the same answer Operations gives.
    await page.goto('/status');
    await expect(page).toHaveURL(/\/login$/);

    await signUp(page);
    await page.goto('/status');
    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'System status' })).toHaveCount(0);
  });

  test('renders a not-found page for an unknown route', async ({ page }) => {
    await page.goto('/nope');
    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
    // A dead end always offers the way back.
    await expect(page.getByRole('link', { name: 'Go to your projects' })).toHaveAttribute(
      'href',
      '/',
    );
  });

  test('the API answers readiness directly, with names and verdicts only', async ({ request }) => {
    const response = await request.get('/health/ready');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['dependencies', 'status']);
    for (const dependency of body.dependencies) {
      expect(Object.keys(dependency).sort()).toEqual(['name', 'status']);
    }
  });
});
