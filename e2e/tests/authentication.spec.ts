import { expect, test, type Page } from '@playwright/test';

/**
 * The full identity journey through a real browser, against the real API and
 * database: sign up, stay signed in across a reload, sign out, sign back in.
 *
 * Each run uses a fresh identity so the suite is repeatable without a reset
 * step.
 */

function uniqueIdentity() {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    email: `e2e-${suffix}@example.test`,
    username: `e2e-${suffix}`,
    password: 'analytical-engine-1843',
  };
}

type Identity = ReturnType<typeof uniqueIdentity>;

/**
 * Signs up and waits until the browser is actually signed in.
 *
 * Returning as soon as the button is clicked would let the next step race the
 * request, which is exactly the kind of flake that makes a suite untrustworthy.
 */
async function signUp(page: Page, identity: Identity): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Username').fill(identity.username);
  await page.getByLabel('Password').fill(identity.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

/** Submits the sign-in form. Does not assume it succeeds. */
async function signIn(page: Page, identifier: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email or username').fill(identifier);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('identity journey', () => {
  test('sign up, reload, sign out, sign back in', async ({ page }) => {
    const identity = uniqueIdentity();

    await signUp(page, identity);
    // Registration signs the user in, so the header shows them straight away.
    await expect(page.getByText(identity.username, { exact: true })).toBeVisible();

    // The session survives a full page load, which is the point of a cookie.
    await page.reload();
    await expect(page.getByText(identity.username, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText(identity.username, { exact: true })).toHaveCount(0);

    // And signing out really ended it, not just hid it.
    await page.reload();
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible();

    await signIn(page, identity.email, identity.password);
    await expect(page.getByText(identity.username, { exact: true })).toBeVisible();
  });

  test('signs in by username as well as email', async ({ page }) => {
    const identity = uniqueIdentity();

    await signUp(page, identity);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible();

    await signIn(page, identity.username, identity.password);
    await expect(page.getByText(identity.username, { exact: true })).toBeVisible();
  });

  test('refuses a wrong password without saying which field was wrong', async ({ page }) => {
    const identity = uniqueIdentity();

    await signUp(page, identity);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible();

    await signIn(page, identity.email, 'definitely-not-the-password');

    await expect(page.getByRole('alert')).toHaveText('Incorrect email, username or password');
    await expect(page.getByLabel('Password')).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('gives the same answer for an account that does not exist', async ({ page }) => {
    await signIn(page, 'nobody-at-all@example.test', 'some-password-here');
    // Any difference would turn sign-in into a way to discover which addresses
    // have accounts.
    await expect(page.getByRole('alert')).toHaveText('Incorrect email, username or password');
  });

  test('sends a signed-in visitor away from the sign-in page', async ({ page }) => {
    await signUp(page, uniqueIdentity());
    await page.goto('/login');
    // Landing on their own projects, which is where the home route sends a
    // signed-in visitor.
    await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  });

  test('the session cookie is not readable by script', async ({ page, context }) => {
    const identity = uniqueIdentity();
    await signUp(page, identity);

    const cookie = (await context.cookies()).find((c) => c.name === 'platform_session');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');

    // A cross-site scripting bug must not be enough to steal the session.
    const visible = await page.evaluate(() => document.cookie);
    expect(visible).not.toContain('platform_session');
  });

  test('a tampered cookie is simply not signed in', async ({ page, context }) => {
    await signUp(page, uniqueIdentity());

    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name === 'platform_session');
    await context.clearCookies();
    await context.addCookies([{ ...session!, value: 'A'.repeat(43) }]);

    await page.reload();
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible();
  });

  test('signing out invalidates the session on the server, not just the browser', async ({
    page,
    context,
    request,
  }) => {
    const identity = uniqueIdentity();
    await signUp(page, identity);

    const session = (await context.cookies()).find((c) => c.name === 'platform_session');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible();

    // Replaying the old token directly must not work.
    const replay = await request.get('/api/auth/me', {
      headers: { Cookie: `platform_session=${session!.value}` },
    });
    expect((await replay.json()).user).toBeNull();
  });

  test('two browsers hold independent sessions', async ({ page, browser }) => {
    const identity = uniqueIdentity();
    await signUp(page, identity);

    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signIn(otherPage, identity.email, identity.password);
    await expect(otherPage.getByText(identity.username, { exact: true })).toBeVisible();

    // Signing out in one must not sign the other out.
    await otherPage.getByRole('button', { name: 'Sign out' }).click();
    await expect(
      otherPage.getByRole('banner').getByRole('link', { name: 'Sign in' }),
    ).toBeVisible();

    await page.reload();
    await expect(page.getByText(identity.username, { exact: true })).toBeVisible();

    await other.close();
  });

  test('one user cannot see another user through the API', async ({ browser, request }) => {
    const first = uniqueIdentity();
    const second = uniqueIdentity();

    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await signUp(pageA, first);
    const cookieA = (await contextA.cookies()).find((c) => c.name === 'platform_session');

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await signUp(pageB, second);

    const asA = await request.get('/api/auth/me', {
      headers: { Cookie: `platform_session=${cookieA!.value}` },
    });
    expect((await asA.json()).user.username).toBe(first.username);

    await contextA.close();
    await contextB.close();
  });

  test('the API never returns a password hash', async ({ request }) => {
    const identity = uniqueIdentity();
    const registered = await request.post('/api/auth/register', { data: identity });
    expect(registered.status()).toBe(201);

    const body = JSON.stringify(await registered.json());
    expect(body).not.toContain(identity.password);
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain('argon2');
  });

  test('rejects a cross-site request even with a valid cookie', async ({ context, request }) => {
    const identity = uniqueIdentity();
    const page = await context.newPage();
    await signUp(page, identity);
    const session = (await context.cookies()).find((c) => c.name === 'platform_session');

    const forged = await request.post('/api/auth/logout-all', {
      headers: {
        Cookie: `platform_session=${session!.value}`,
        Origin: 'https://evil.example',
      },
      failOnStatusCode: false,
    });

    expect(forged.status()).toBe(403);
  });
});
