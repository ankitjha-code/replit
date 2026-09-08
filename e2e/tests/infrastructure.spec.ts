import { expect, test } from '@playwright/test';

/**
 * Drives the platform through the reverse proxy on its single public origin,
 * which is how a user will actually reach it. Requires the infrastructure to
 * be running:
 *
 *   pnpm infra:up
 *
 * Skips when the proxy is not reachable rather than pretending to pass.
 */

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
    await page.goto(`${PROXY_ORIGIN}/status`);
    await expect(page.getByRole('heading', { name: 'Control plane' })).toBeVisible();
  });

  test('the browser reaches the API on that same origin', async ({ page }) => {
    // No cross-origin request is involved: the page and its API calls share
    // an origin here exactly as they will in production.
    const response = await page.goto(`${PROXY_ORIGIN}/health/ready`);
    expect(response?.status()).toBe(200);
  });

  test('shows the real infrastructure the control plane is wired to', async ({ page, request }) => {
    const reported = await (await request.get(`${PROXY_ORIGIN}/health/ready`)).json();
    test.skip(
      reported.dependencies.length === 0,
      'No infrastructure configured in this environment',
    );

    await page.goto(`${PROXY_ORIGIN}/status`);
    for (const dependency of reported.dependencies) {
      await expect(page.getByText(dependency.name, { exact: true })).toBeVisible();
    }
  });

  test('a preview host is routed away from the platform', async ({ request }) => {
    // Host-based routing cannot be exercised through a browser without DNS,
    // so the header is set directly.
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
