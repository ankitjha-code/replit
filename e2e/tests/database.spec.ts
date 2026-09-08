import { expect, test, type Page } from '@playwright/test';

/**
 * The database a project's application gets, in a real browser.
 *
 * Two halves, and the second is the one that matters. An owner can create a
 * database and read its connection details. Then the project's own container,
 * started with those details already in its environment, opens a socket to that
 * host and gets the PostgreSQL wire protocol back.
 *
 * A TCP connect on its own would prove only that something is listening, which
 * is the mistake this project already made once with preview ports. So the probe
 * sends the eight bytes that begin a PostgreSQL conversation and reads the
 * reply.
 *
 * Whether the credential authenticates, and whether it reaches anything it
 * should not, is checked in the API suite where a real client can be used.
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

/** Signs up and makes a project, returning its id. */
async function newProject(page: Page, name = 'Ledger'): Promise<string> {
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

async function openSettings(page: Page, projectId: string) {
  await page.goto(`/projects/${projectId}/settings`);
  // Exact: the project's own name is also a heading on this page, and a
  // substring match finds that instead.
  await expect(page.getByRole('heading', { name: 'Database', exact: true })).toBeVisible();
}

async function stopRuntime(page: Page, projectId: string) {
  await page.request.post(`/api/projects/${projectId}/runtime/stop`, { data: {} });
}

/** The probe the container runs. Written as a project file rather than typed. */
const PROBE =
  "/*\n * Proves this container can reach a real PostgreSQL server at PGHOST.\n *\n * Opens a socket and sends the eight-byte SSLRequest that begins the PostgreSQL\n * wire protocol. A server that answers 'N' or 'S' is speaking that protocol; an\n * open port that answers anything else, or nothing, is not. That distinction is\n * the point: a TCP connect on its own proves only that something is listening.\n */\nconst net = require('node:net');\n\nconst socket = net.connect(Number(process.env.PGPORT), process.env.PGHOST, () => {\n  const request = Buffer.alloc(8);\n  request.writeInt32BE(8, 0);\n  request.writeInt32BE(80877103, 4);\n  socket.write(request);\n});\n\nsocket.on('data', (data) => {\n  console.log('db' + '-speaks-' + String.fromCharCode(data[0]));\n  socket.end();\n});\n\nsocket.on('error', (error) => {\n  console.log('db' + '-error-' + error.code);\n});\n";

test.describe('a project database', () => {
  test('says there is none, then makes one', async ({ page }) => {
    const projectId = await newProject(page);
    await openSettings(page, projectId);

    await expect(page.getByText('This project has no database.')).toBeVisible();
    await page.getByRole('button', { name: 'Create a database' }).click();

    // The host is a container name, shown because that is where it resolves.
    await expect(page.getByText('platform-userdb').first()).toBeVisible({ timeout: 60_000 });
    // The port cell, not the port inside the connection URL below it.
    await expect(page.getByText('5432', { exact: true })).toBeVisible();
  });

  test('keeps the password hidden until it is asked for', async ({ page }) => {
    const projectId = await newProject(page);
    await openSettings(page, projectId);
    await page.getByRole('button', { name: 'Create a database' }).click();
    await expect(page.getByText('platform-userdb').first()).toBeVisible({ timeout: 60_000 });

    // Owner-only is not the same as safe to have on screen in a meeting.
    const hidden = page.getByRole('button', { name: 'Show password' });
    await expect(hidden).toBeVisible();
    await hidden.click();
    await expect(page.getByRole('button', { name: 'Show password' })).toBeHidden();
  });

  test('survives a reload, because it is on the server', async ({ page }) => {
    const projectId = await newProject(page);
    await openSettings(page, projectId);
    await page.getByRole('button', { name: 'Create a database' }).click();
    await expect(page.getByText('platform-userdb').first()).toBeVisible({ timeout: 60_000 });

    await page.reload();
    await expect(page.getByText('platform-userdb').first()).toBeVisible();
    await expect(page.getByText('This project has no database.')).toBeHidden();
  });

  test('refuses a second one rather than replacing the first', async ({ page }) => {
    const projectId = await newProject(page);
    await openSettings(page, projectId);
    await page.getByRole('button', { name: 'Create a database' }).click();
    await expect(page.getByText('platform-userdb').first()).toBeVisible({ timeout: 60_000 });

    const again = await page.request.post(`/api/projects/${projectId}/database`, { data: {} });
    expect(again.status()).toBe(409);
  });

  test('the project container reaches a real PostgreSQL server', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await newProject(page);

    await writeFile(page, projectId, 'package.json', '{}');
    await writeFile(page, projectId, 'dbcheck.js', PROBE);

    await openSettings(page, projectId);
    await page.getByRole('button', { name: 'Create a database' }).click();
    await expect(page.getByText('platform-userdb').first()).toBeVisible({ timeout: 60_000 });

    // Started after the database exists, so its environment carries it.
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.locator('.runtime-chip')).toHaveText('Running', { timeout: 280_000 });

    await page.getByRole('tab', { name: 'Shell' }).click();
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await page.locator('.xterm-screen').first().click();
    await page.keyboard.type('node dbcheck.js');
    await page.keyboard.press('Enter');

    /*
     * 'N' or 'S' is PostgreSQL answering. The marker is assembled by the
     * program from pieces, so the terminal's echo of the command that ran it
     * cannot satisfy this on its own.
     */
    await expect
      .poll(async () => (await page.locator('.xterm-rows').first().textContent()) ?? '', {
        timeout: 60_000,
      })
      .toMatch(/db-speaks-[NS]/);

    await stopRuntime(page, projectId);
  });

  test('an application with no database is told nothing about one', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await newProject(page);
    await writeFile(page, projectId, 'package.json', '{}');

    await page.goto(`/projects/${projectId}`);
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.locator('.runtime-chip')).toHaveText('Running', { timeout: 280_000 });

    await page.getByRole('tab', { name: 'Shell' }).click();
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await page.locator('.xterm-screen').first().click();
    await page.keyboard.type('echo "[$PGHOST]" && echo probe\'\'-done');
    await page.keyboard.press('Enter');

    await expect
      .poll(async () => (await page.locator('.xterm-rows').first().textContent()) ?? '', {
        timeout: 60_000,
      })
      .toMatch(/probe-done/);

    // Empty, rather than pointing at a database this project does not have.
    const screen = (await page.locator('.xterm-rows').first().textContent()) ?? '';
    expect(screen).toContain('[]');

    await stopRuntime(page, projectId);
  });
});
