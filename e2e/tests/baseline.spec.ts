import { expect, test } from '@playwright/test';

/**
 * Baseline journey: the browser loads the shell and it reflects real
 * control-plane state. Feature journeys (register, create project, run,
 * preview, deploy) are added to this suite as those features land.
 */
test.describe('platform baseline', () => {
  test('serves the workspace shell', async ({ page }) => {
    await page.goto('/status');
    await expect(page.getByRole('heading', { name: 'Control plane' })).toBeVisible();
  });

  test('the status page shows exactly what the API reports', async ({ page, request }) => {
    const reported = await (await request.get('/health/ready')).json();

    await page.goto('/status');
    await expect(page.getByText(reported.service, { exact: true })).toBeVisible();

    if (reported.dependencies.length === 0) {
      // Nothing is configured, and the UI must say so rather than invent a row.
      await expect(page.getByText('No dependencies registered yet.')).toBeVisible();
    } else {
      for (const dependency of reported.dependencies) {
        await expect(page.getByText(dependency.name, { exact: true })).toBeVisible();
      }
      await expect(page.getByText('No dependencies registered yet.')).toHaveCount(0);
    }
  });

  test('renders a not-found page for an unknown route', async ({ page }) => {
    await page.goto('/nope');
    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
  });

  test('the API answers readiness directly', async ({ request }) => {
    const response = await request.get('/health/ready');
    expect(response.status()).toBe(200);
    expect((await response.json()).service).toBe('api');
  });
});
