import { expect, test, type Page } from '@playwright/test';

/**
 * Registration through a real browser, against the real API and database.
 *
 * Each run uses a fresh identity so the suite is repeatable without a reset
 * step, and so a leftover row from a previous run cannot make a case pass or
 * fail for the wrong reason.
 */

function uniqueIdentity() {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    email: `e2e-${suffix}@example.test`,
    username: `e2e-${suffix}`,
    password: 'analytical-engine-1843',
  };
}

async function fillForm(
  page: Page,
  identity: { email: string; username: string; password: string },
) {
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Username').fill(identity.username);
  await page.getByLabel('Password').fill(identity.password);
}

test.describe('registration', () => {
  test('a visitor can reach the sign-up page from the shell', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Sign up' }).click();
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  });

  test('creates a real account', async ({ page, request }) => {
    const identity = uniqueIdentity();

    await page.goto('/register');
    await fillForm(page, identity);
    await page.getByRole('button', { name: 'Create account' }).click();

    // Registration signs the user in, so the header shows them immediately.
    await expect(page.getByText(identity.username, { exact: true })).toBeVisible();

    // The account really exists: registering the same email again conflicts.
    const again = await request.post('/api/auth/register', {
      data: identity,
      failOnStatusCode: false,
    });
    expect(again.status()).toBe(409);
  });

  test('signs the new user in', async ({ page }) => {
    const identity = uniqueIdentity();

    await page.goto('/register');
    await fillForm(page, identity);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('shows a duplicate email against the email field', async ({ page }) => {
    const identity = uniqueIdentity();

    await page.goto('/register');
    await fillForm(page, identity);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

    // Signed out first, because the sign-up page redirects a signed-in visitor.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible();

    await page.goto('/register');
    await fillForm(page, { ...identity, username: `${identity.username}-two` });
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByText('An account with that email already exists')).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
  });

  test('refuses a reserved username without contacting the server', async ({ page }) => {
    await page.goto('/register');

    let requested = false;
    await page.route('**/api/auth/register', async (route) => {
      requested = true;
      await route.continue();
    });

    await fillForm(page, { ...uniqueIdentity(), username: 'admin' });
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByText(/reserved by the platform/i)).toBeVisible();
    expect(requested).toBe(false);
  });

  test('the password is never sent back in the response', async ({ request }) => {
    const identity = uniqueIdentity();
    const response = await request.post('/api/auth/register', { data: identity });

    expect(response.status()).toBe(201);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain(identity.password);
    expect(body).not.toContain('passwordHash');
  });

  test('rejects a weak password at the API even if the form is bypassed', async ({ request }) => {
    const response = await request.post('/api/auth/register', {
      data: { ...uniqueIdentity(), password: 'password123' },
      failOnStatusCode: false,
    });

    expect(response.status()).toBe(422);
    expect((await response.json()).error.code).toBe('VALIDATION_FAILED');
  });
});
