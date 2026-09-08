import { expect, test, type Page } from '@playwright/test';

/**
 * The terminal, in a real browser, attached to a real container.
 *
 * The whole path with nothing stood in for: a WebSocket from the page, through
 * the control plane's authorization, into a pseudo-terminal inside the
 * project's own container. What is typed here really runs, and the assertions
 * read what the shell printed back.
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

async function openWorkspace(page: Page, name = 'Terminal Test'): Promise<string> {
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

/** Creates a runnable project and starts it. */
async function runningProject(page: Page, marker = 'hello'): Promise<string> {
  const projectId = await openWorkspace(page);
  await writeFile(page, projectId, 'index.html', `<h1>${marker}</h1>`);
  await page.reload();

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.runtime-chip')).toHaveText('Running', { timeout: 280_000 });
  await openShell(page);
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

/** Everything the terminal has painted. */
async function screenText(page: Page): Promise<string> {
  return (await page.locator('.xterm-rows').first().textContent()) ?? '';
}

/** Types into the terminal and waits for what it prints. */
async function runCommand(page: Page, command: string, expected: RegExp): Promise<void> {
  // xterm keeps its input in a hidden textarea and paints the rest itself, so
  // the thing to click is the painted screen.
  await page.locator('.xterm-screen').first().click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');

  await expect.poll(() => screenText(page), { timeout: 30_000 }).toMatch(expected);
}

async function stopRuntime(page: Page, projectId: string) {
  await page.request.post(`/api/projects/${projectId}/runtime/stop`, { data: {} });
}

test.describe('the terminal', () => {
  test('says nothing is running before the project is started', async ({ page }) => {
    await openWorkspace(page);
    await openShell(page);

    // Not an empty black rectangle, which looks exactly like a shell waiting
    // for input.
    await expect(page.getByText('Nothing is running')).toBeVisible();
    await expect(page.locator('.xterm')).toHaveCount(0);
  });

  test('says where a command would run before anyone runs one', async ({ page }) => {
    await openWorkspace(page);
    await openShell(page);
    await expect(page.getByText(/never on the platform/)).toBeVisible();
  });

  test('opens a shell once the project is running', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);

    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    // A prompt means the shell attached and is waiting, which nothing else in
    // the page could have drawn.
    await expect.poll(() => screenText(page), { timeout: 30_000 }).toMatch(/[#$] ?$|[#$]\s/);

    await stopRuntime(page, projectId);
  });

  test('runs what is typed and shows the output', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await runCommand(page, 'echo terminal-really-works', /terminal-really-works/);

    await stopRuntime(page, projectId);
  });

  test('runs inside this project container, not somewhere else', async ({ page }) => {
    // The strongest evidence available from the browser: the shell can read a
    // file that only exists because this project's files were copied into this
    // project's container.
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    // A short answer on purpose. The console panel is a few rows tall and only
    // the visible rows can be read back, so a long one scrolls the part being
    // looked for out of view.
    await runCommand(page, 'ls', /index\.html/);

    await stopRuntime(page, projectId);
  });

  test('a command can change the container filesystem', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await runCommand(page, 'echo made-by-the-terminal > /tmp/proof.txt', /proof\.txt/);

    /*
     * Read back in a second command, with the marker split by quoting.
     *
     * A pseudo-terminal echoes what is typed, so a marker that appears in the
     * command itself is on screen before the command has run. Written as
     * `REA''D-BACK`, only the shell's own output can produce `READ-BACK`, and
     * the `&&` means it is produced only if the file was really there.
     */
    await runCommand(page, "cat /tmp/proof.txt && echo REA''D-BACK", /READ-BACK/);

    await stopRuntime(page, projectId);
  });

  test('keeps the shell running across a reload, with its screen', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    /*
     * Both markers are assembled by the shell from quoted pieces.
     *
     * The terminal echoes every line that is typed into it, so a marker that
     * appears whole in the command is satisfied by the echo alone and proves
     * nothing. Split by quoting, the joined-up text can only come from the
     * shell having actually run something.
     */
    await runCommand(page, "echo before''-the''-reload", /before-the-reload/);
    /*
     * The assignment prints its own confirmation.
     *
     * Waiting for the terminal's echo of what was typed proves nothing about
     * the shell and is unreliable besides: xterm pads a painted row, so the
     * characters on screen are not the characters that were sent. Only output
     * the shell produced is worth asserting on.
     */
    await runCommand(page, "MARKER=shell''-survived''-reload && echo mark''-set", /mark-set/);

    await page.reload();
    await openShell(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    // The screen comes back, rebuilt from what the shell printed while the
    // old page was going away.
    await expect.poll(() => screenText(page), { timeout: 30_000 }).toMatch(/before-the-reload/);

    // And it is the same shell, not a new one showing an old screen: a fresh
    // shell has never heard of this variable and would print an empty line.
    await runCommand(page, 'echo "$MARKER"', /shell-survived-reload/);

    await stopRuntime(page, projectId);
  });

  test('says the terminal was reattached rather than letting it look new', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    await runCommand(page, "echo any''thing", /anything/);

    await page.reload();
    await openShell(page);

    await expect(page.getByText(/Reattached to the terminal you already had open/)).toBeVisible({
      timeout: 30_000,
    });

    await stopRuntime(page, projectId);
  });

  test('New terminal throws the old shell away and starts another', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    await runCommand(page, "KEPT=should''-not''-survive && echo kept''-set", /kept-set/);

    await page.reload();
    await openShell(page);
    await expect(page.getByText(/Reattached to the terminal you already had open/)).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole('button', { name: 'New terminal', exact: true }).click();
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    /*
     * A fresh shell prints an empty line for a variable it never had. Proving
     * an absence by polling is unreliable, so the check is positive: a marker
     * printed after the variable shows the command ran, and the variable's own
     * value must not be on the screen when it does.
     */
    await runCommand(page, `echo "$KEPT" && echo new''-shell''-here`, /new-shell-here/);
    expect(await screenText(page)).not.toMatch(/should-not-survive/);

    await stopRuntime(page, projectId);
  });

  test('closes the terminal when the project is stopped', async ({ page }) => {
    test.setTimeout(300_000);
    await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.locator('.runtime-chip')).toHaveText('Stopped', { timeout: 60_000 });

    // Back to saying so, rather than leaving a dead terminal that still takes
    // typing.
    await expect(page.getByText('Nothing is running')).toBeVisible({ timeout: 30_000 });
  });

  test('refuses a socket opened from another page', async ({ page, request }) => {
    // The attack this stops: a page the person is visiting opens this socket,
    // the browser attaches their cookie, and that page has a shell in their
    // project. Checked at the API, because a browser will not let a test forge
    // an Origin header.
    const projectId = await openWorkspace(page);

    const response = await request.get(`/ws/projects/${projectId}/terminal`, {
      headers: {
        Origin: 'https://evil.example',
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });

    expect(response.status()).toBe(403);
  });
});
