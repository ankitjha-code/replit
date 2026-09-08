import { expect, test, type Page } from '@playwright/test';

/**
 * The preview, in a real browser, of a real server in a real container.
 *
 * The project is started, a server is started inside it from the terminal, and
 * the page it serves is read back through the platform's proxy. Nothing in
 * this file stands in for anything.
 */

function uniqueIdentity() {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    email: `e2e-${suffix}@example.test`,
    username: `e2e-${suffix}`,
    password: 'analytical-engine-1843',
  };
}

async function signUp(page: Page): Promise<void> {
  const identity = uniqueIdentity();
  await page.goto('/register');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Username').fill(identity.username);
  await page.getByLabel('Password').fill(identity.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function openWorkspace(page: Page, name = 'Preview Test'): Promise<string> {
  await signUp(page);
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await expect(page.getByRole('region', { name: 'Files' })).toBeVisible();
  return page.url().split('/projects/')[1]!;
}

async function writeFile(page: Page, projectId: string, path: string, content: string) {
  const response = await page.request.put(`/api/projects/${projectId}/files/content`, {
    data: { path, content, encoding: 'utf8' },
  });
  expect(response.status()).toBe(200);
}

const MARKER = 'served-from-the-container';

/** Starts a project whose files contain a page worth previewing. */
async function runningProject(page: Page): Promise<string> {
  const projectId = await openWorkspace(page);
  await writeFile(page, projectId, 'index.html', `<h1>${MARKER}</h1>`);
  await page.reload();

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.runtime-chip')).toHaveText('Running', { timeout: 280_000 });
  return projectId;
}

/**
 * Brings the shell tab forward.
 *
 * The console opens on the application's output, because that is what pressing
 * Run produces. The terminal is the other tab, and nothing is mounted for it
 * until it is chosen.
 */
async function openShell(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Shell' }).click();
}

/** Starts a web server inside the project, from the project's own terminal. */
async function serveFromTerminal(page: Page): Promise<void> {
  await openShell(page);
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
  // Wait for a prompt rather than typing the instant the terminal appears. The
  // client holds early keystrokes, and this also proves the shell is there.
  await expect
    .poll(() => page.locator('.xterm-rows').first().textContent(), { timeout: 30_000 })
    .toMatch(/[#$]/);
  await page.locator('.xterm-screen').first().click();
  // BusyBox's own web server, which is what the static runtime image provides.
  await page.keyboard.type('busybox httpd -p 8000 -h /workspace');
  await page.keyboard.press('Enter');
}

async function stopRuntime(page: Page, projectId: string) {
  await page.request.post(`/api/projects/${projectId}/runtime/stop`, { data: {} });
}

test.describe('the preview', () => {
  test('says there is nothing to preview before the project is started', async ({ page }) => {
    await openWorkspace(page);

    await expect(page.getByText('Nothing to preview')).toBeVisible();
    await expect(page.locator('iframe[title="Project preview"]')).toHaveCount(0);
  });

  test('says nothing is listening while the project serves nothing', async ({ page }) => {
    // Running is not serving. Showing a frame here would show a browser error
    // page and blame the platform for it.
    test.setTimeout(300_000);
    const projectId = await runningProject(page);

    await expect(page.getByText('Nothing to preview yet')).toBeVisible({ timeout: 30_000 });
    // The container is up and no application has been started in it, so the
    // reason names the step that is missing rather than the symptom.
    await expect(page.getByText(/its application has not been started/)).toBeVisible();

    await stopRuntime(page, projectId);
  });

  test('finds the application once a server is started in the terminal', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await serveFromTerminal(page);

    // The panel finds it on its own: nobody presses anything.
    await expect(page.getByText('port 8000')).toBeVisible({ timeout: 60_000 });

    await stopRuntime(page, projectId);
  });

  test('says why it cannot show the page inside the workspace over plain HTTP', async ({
    page,
  }) => {
    // A preview is on its own site, so the cookie carrying permission is a
    // third-party one in a frame, and a browser sends those only over HTTPS.
    // Saying so beats framing a page that loads a refusal.
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await serveFromTerminal(page);
    await expect(page.getByText('port 8000')).toBeVisible({ timeout: 60_000 });

    await expect(page.getByText(/will not carry the preview/)).toBeVisible();
    await expect(page.locator('iframe[title="Project preview"]')).toHaveCount(0);

    await stopRuntime(page, projectId);
  });

  test('serves the preview from a different origin than the workspace', async ({ page }) => {
    // The reason the whole feature is shaped this way. On the workspace's own
    // origin, a project's code could read the API as the person looking at it.
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await serveFromTerminal(page);
    await expect(page.getByText('port 8000')).toBeVisible({ timeout: 60_000 });

    const state = await (await page.request.get(`/api/projects/${projectId}/preview`)).json();
    expect(new URL(state.url).origin).not.toBe(new URL(page.url()).origin);
    expect(new URL(state.url).hostname.startsWith(projectId)).toBe(true);

    await stopRuntime(page, projectId);
  });

  test('shows the page the project serves, in a tab', async ({ page, context }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await serveFromTerminal(page);
    await expect(page.getByText('port 8000')).toBeVisible({ timeout: 60_000 });

    const [tab] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('link', { name: 'Open in a tab' }).click(),
    ]);

    await expect(tab.locator('h1')).toHaveText(MARKER, { timeout: 60_000 });
    await tab.close();

    await stopRuntime(page, projectId);
  });

  test('refuses a browser that was never let in', async ({ page, browser }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await serveFromTerminal(page);
    await expect(page.getByText('port 8000')).toBeVisible({ timeout: 60_000 });

    const state = await (await page.request.get(`/api/projects/${projectId}/preview`)).json();

    // A whole separate browser context, so no cookie for the preview host. The
    // address alone is not permission. Driven through a real browser because
    // only a browser resolves a name under `localhost` without any DNS.
    const stranger = await browser.newContext();
    const strangerPage = await stranger.newPage();
    const response = await strangerPage.goto(state.url as string);

    expect(response?.status()).toBe(401);
    await expect(strangerPage.locator('h1')).toHaveText('Not signed in for this preview');
    await stranger.close();

    await stopRuntime(page, projectId);
  });

  test('refuses a caller who is not a member', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await signUp(page);

    expect((await page.request.get(`/api/projects/${projectId}/preview`)).status()).toBe(404);
    expect(
      (await page.request.post(`/api/projects/${projectId}/preview/grant`, { data: {} })).status(),
    ).toBe(404);
  });
});
