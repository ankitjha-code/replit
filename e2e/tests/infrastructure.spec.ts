import { expect, test } from '@playwright/test';

const PROXY_ORIGIN = process.env.E2E_PROXY_ORIGIN ?? 'http://localhost:8080';

let proxyUp = false;

test.beforeAll(async ({ playwright }) => {
  const probe = await playwright.request.newContext();
  try {
    const response = await probe.get(`${PROXY_ORIGIN}/__proxy/health`, { timeout: 3_000 });
    proxyUp = response.ok();
  } catch {
    proxyUp = false;
  } finally {
    await probe.dispose();
  }
});

test.describe('through the reverse proxy', () => {
  test.beforeEach(() => {
    test.skip(!proxyUp, `Proxy not reachable at ${PROXY_ORIGIN}. Run: pnpm infra:up`);
  });

  test('serves the whole platform from one origin', async ({ page }) => {
    await page.goto(`${PROXY_ORIGIN}/`);
    await expect(
      page.getByRole('heading', { level: 1, name: /Build and run applications in the browser/ }),
    ).toBeVisible();
  });

  test('the browser reaches the API on that same origin', async ({ page }) => {
    const response = await page.goto(`${PROXY_ORIGIN}/health/ready`);
    expect(response?.status()).toBe(200);
  });

  test('names the real infrastructure without describing it', async ({ request }) => {
    const reported = await (await request.get(`${PROXY_ORIGIN}/health/ready`)).json();
    test.skip(
      reported.dependencies.length === 0,
      'No infrastructure configured in this environment',
    );

    for (const dependency of reported.dependencies) {
      expect(Object.keys(dependency).sort()).toEqual(['name', 'status']);
    }
    expect(reported.version).toBeUndefined();
  });

  test('a preview host is routed away from the platform', async ({ request }) => {
    const response = await request.get(`${PROXY_ORIGIN}/`, {
      headers: { Host: 'some-project.preview.localhost' },
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(503);
    expect((await response.json()).error.code).toBe('RUNTIME_UNAVAILABLE');
  });

  test('a deployment host is routed away from the platform', async ({ request }) => {
    const response = await request.get(`${PROXY_ORIGIN}/`, {
      headers: { Host: 'some-app.app.localhost' },
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(404);
  });
});
