import { expect, test } from '@playwright/test';
import { signUp } from './helpers.js';

test.describe('platform baseline', () => {
  test('serves the workspace shell', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: /Build and run applications in the browser/ }),
    ).toBeVisible();
  });

  test('keeps the status page to operators', async ({ page }) => {
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
