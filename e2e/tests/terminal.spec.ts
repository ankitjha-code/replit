import { expect, test, type Page } from '@playwright/test';
import { openShell, openWorkspace, startedProject, stopRuntime } from './helpers.js';

async function runningProject(page: Page, marker = 'hello'): Promise<string> {
  const projectId = await startedProject(page, { marker });
  await openShell(page);
  return projectId;
}

function shownShell(page: Page) {
  return page.locator('.term-panel__session:not([hidden])');
}

async function screenText(page: Page): Promise<string> {
  return (await shownShell(page).locator('.xterm-rows').first().textContent()) ?? '';
}

async function runCommand(page: Page, command: string, expected: RegExp): Promise<void> {
  await shownShell(page).locator('.xterm-screen').first().click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');

  await expect.poll(() => screenText(page), { timeout: 30_000 }).toMatch(expected);
}

test.describe('the terminal', () => {
  test('says nothing is running before the project is started', async ({ page }) => {
    await openWorkspace(page);
    await openShell(page);

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
    await expect.poll(() => screenText(page), { timeout: 30_000 }).toMatch(/[#$] ?$|[#$]\s/);

    const screen = await screenText(page);
    expect(screen).toMatch(/\/workspace/);
    expect(screen).not.toMatch(/Script started/);
    await expect(page.getByRole('tab', { name: 'Shell 1', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await stopRuntime(page, projectId);
  });

  test('stays the same shell across Output and Shell, with nothing reattached', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    await runCommand(page, "echo still''-here", /still-here/);

    await page.getByRole('tab', { name: 'Output', exact: true }).click();
    await page.getByRole('tab', { name: 'Shell', exact: true }).click();

    await expect(shownShell(page).locator('.xterm')).toHaveCount(1);
    expect(await screenText(page)).toMatch(/still-here/);
    await expect(page.getByText(/Reattached to the terminal/)).toHaveCount(0);

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
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await runCommand(page, 'ls', /index\.html/);

    await stopRuntime(page, projectId);
  });

  test('a command can change the container filesystem', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await runCommand(page, 'echo made-by-the-terminal > /tmp/proof.txt', /proof\.txt/);

    await runCommand(page, "cat /tmp/proof.txt && echo REA''D-BACK", /READ-BACK/);

    await stopRuntime(page, projectId);
  });

  test('keeps the shell running across a reload, with its screen', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await runCommand(page, "echo before''-the''-reload", /before-the-reload/);
    await runCommand(page, "MARKER=shell''-survived''-reload && echo mark''-set", /mark-set/);

    await page.reload();
    await openShell(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await expect.poll(() => screenText(page), { timeout: 30_000 }).toMatch(/before-the-reload/);

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

  test('New terminal opens another shell and keeps the first', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    await runCommand(page, "FIRST=first''-shell && echo first''-set", /first-set/);

    await page.getByRole('button', { name: 'New terminal', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Shell 2', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await runCommand(page, `echo "$FIRST" && echo second''-shell''-here`, /second-shell-here/);
    expect(await screenText(page)).not.toMatch(/first-shell/);

    await page.getByRole('tab', { name: 'Shell 1', exact: true }).click();
    await runCommand(page, 'echo "$FIRST"', /first-shell/);

    await stopRuntime(page, projectId);
  });

  test('Restart shell throws a shell away and starts another in its place', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    await runCommand(page, "KEPT=should''-not''-survive && echo kept''-set", /kept-set/);

    await page.reload();
    await openShell(page);
    await expect(page.getByText(/Reattached to the terminal you already had open/)).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole('button', { name: 'Shell actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Restart shell' }).click();
    await expect(shownShell(page).locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await runCommand(page, `echo "$KEPT" && echo new''-shell''-here`, /new-shell-here/);
    expect(await screenText(page)).not.toMatch(/should-not-survive/);
    await expect(page.getByRole('tab', { name: /^Shell \d$/ })).toHaveCount(1);

    await stopRuntime(page, projectId);
  });

  test('closes the terminal when the project is stopped', async ({ page }) => {
    test.setTimeout(300_000);
    await runningProject(page);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('.runtime-chip')).toHaveText('Stopped', { timeout: 60_000 });

    await expect(page.getByText('Nothing is running')).toBeVisible({ timeout: 30_000 });
  });

  test('refuses a socket opened from another page', async ({ page, request }) => {
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
