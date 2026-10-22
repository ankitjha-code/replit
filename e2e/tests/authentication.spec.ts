import { expect, test } from '@playwright/test';
import { signIn, signOut, signUp, uniqueIdentity } from './helpers.js';

test.describe('identity journey', () => {
  test('sign up, reload, sign out, sign back in', async ({ page }) => {
    const identity = uniqueIdentity();

    await signUp(page, identity);
    await expect(page.getByText(identity.username, { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByText(identity.username, { exact: true })).toBeVisible();

    await signOut(page);
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText(identity.username, { exact: true })).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible();

    await signIn(page, identity.email, identity.password);
    await expect(page.getByText(identity.username, { exact: true })).toBeVisible();
  });

  test('signs in by username as well as email', async ({ page }) => {
    const identity = uniqueIdentity();

    await signUp(page, identity);
    await signOut(page);
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible();

    await signIn(page, identity.username, identity.password);
    await expect(page.getByText(identity.username, { exact: true })).toBeVisible();
  });

  test('refuses a wrong password without saying which field was wrong', async ({ page }) => {
    const identity = uniqueIdentity();

    await signUp(page, identity);
    await signOut(page);
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible();

    await signIn(page, identity.email, 'definitely-not-the-password');

    await expect(page.getByRole('alert')).toHaveText('Incorrect email, username or password');
    await expect(page.getByLabel('Password', { exact: true })).not.toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  test('gives the same answer for an account that does not exist', async ({ page }) => {
    await signIn(page, 'nobody-at-all@example.test', 'some-password-here');
    await expect(page.getByRole('alert')).toHaveText('Incorrect email, username or password');
  });

  test('sends a signed-in visitor away from the sign-in page', async ({ page }) => {
    await signUp(page, uniqueIdentity());
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  });

  test('the session cookie is not readable by script', async ({ page, context }) => {
    const identity = uniqueIdentity();
    await signUp(page, identity);

    const cookie = (await context.cookies()).find((c) => c.name === 'platform_session');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');

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
    await signOut(page);
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible();

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

    await signOut(otherPage);
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
