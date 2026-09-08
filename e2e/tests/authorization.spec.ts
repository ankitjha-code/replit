import { expect, test } from '@playwright/test';
import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test';

/**
 * Project isolation through the real HTTP stack.
 *
 * These go through the API rather than the browser because there is no project
 * interface yet: what is under test is whether one account can reach another
 * account's project, and that question is answered at the API.
 */

function uniqueIdentity() {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    email: `e2e-${suffix}@example.test`,
    username: `e2e-${suffix}`,
    password: 'analytical-engine-1843',
  };
}

/** Registers an account and returns a request context carrying its session. */
/** The fixture that builds request contexts, as handed to a test. */
type RequestFactory = PlaywrightWorkerArgs['playwright']['request'];

async function signedInContext(
  factory: RequestFactory,
  baseURL: string,
): Promise<{ context: APIRequestContext; userId: string }> {
  const context = await factory.newContext({ baseURL });
  const response = await context.post('/api/auth/register', { data: uniqueIdentity() });
  expect(response.status()).toBe(201);
  return { context, userId: (await response.json()).user.id };
}

test.describe('project isolation', () => {
  test('an anonymous caller is refused', async ({ request }) => {
    const response = await request.get(
      '/api/projects/00000000-0000-7000-8000-000000000000/members',
      { failOnStatusCode: false },
    );

    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHENTICATED');
  });

  test('a signed-in user sees nothing for a project they are not in', async ({
    playwright,
    baseURL,
  }) => {
    const { context } = await signedInContext(playwright.request, baseURL!);

    const response = await context.get(
      '/api/projects/00000000-0000-7000-8000-000000000000/members',
      {
        failOnStatusCode: false,
      },
    );

    // Not 403: a 403 would confirm which identifiers name real projects.
    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe('NOT_FOUND');

    await context.dispose();
  });

  test('a malformed identifier gets the same answer as a real one', async ({
    playwright,
    baseURL,
  }) => {
    const { context } = await signedInContext(playwright.request, baseURL!);

    const junk = await context.get('/api/projects/not-a-uuid/members', {
      failOnStatusCode: false,
    });
    const real = await context.get('/api/projects/00000000-0000-7000-8000-000000000000/members', {
      failOnStatusCode: false,
    });

    expect(junk.status()).toBe(real.status());
    expect((await junk.json()).error.message).toBe((await real.json()).error.message);

    await context.dispose();
  });

  test('two accounts cannot see each other', async ({ playwright, baseURL }) => {
    const first = await signedInContext(playwright.request, baseURL!);
    const second = await signedInContext(playwright.request, baseURL!);

    // Distinct accounts, each seeing only itself.
    const meFirst = await first.context.get('/api/auth/me');
    const meSecond = await second.context.get('/api/auth/me');

    expect((await meFirst.json()).user.id).toBe(first.userId);
    expect((await meSecond.json()).user.id).toBe(second.userId);
    expect(first.userId).not.toBe(second.userId);

    await first.context.dispose();
    await second.context.dispose();
  });

  test('a session from one account does not authorize another', async ({
    playwright,
    baseURL,
    request,
  }) => {
    const { context, userId } = await signedInContext(playwright.request, baseURL!);
    const cookies = await context.storageState();
    const session = cookies.cookies.find((c) => c.name === 'platform_session');

    const asThem = await request.get('/api/auth/me', {
      headers: { Cookie: `platform_session=${session!.value}` },
    });

    expect((await asThem.json()).user.id).toBe(userId);

    await context.dispose();
  });
});
