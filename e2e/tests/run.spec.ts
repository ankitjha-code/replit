import { expect, test, type Locator, type Page } from '@playwright/test';
import { openWorkspace, startedProject, stopRuntime, writeFile } from './helpers.js';

function consoleOf(page: Page): Locator {
  return page.getByRole('region', { name: 'Console' });
}

function runButton(page: Page): Locator {
  return consoleOf(page).getByRole('button', { name: 'Run', exact: true });
}

async function setCommand(page: Page, command: string): Promise<void> {
  await consoleOf(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Run command').fill(command);
  await consoleOf(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(consoleOf(page).getByText(command, { exact: true })).toBeVisible();
}

test.describe('running an application', () => {
  test('will not run anything before the project is started', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await writeFile(page, projectId, 'index.html', '<h1>hello</h1>');

    const run = runButton(page);
    await expect(run).toBeDisabled();
    await expect(run).toHaveAttribute('title', /Start the environment/);
    await expect(
      consoleOf(page).getByText(/Start the environment before running the app/),
    ).toBeVisible();
    await expect(consoleOf(page).getByRole('button', { name: 'Show me' })).toBeVisible();
  });

  test('says what it would run, and where that came from', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await writeFile(page, projectId, 'index.html', '<h1>hello</h1>');

    await expect(consoleOf(page).getByTitle(/Suggested by the platform/)).toBeVisible();
    await expect(consoleOf(page).getByText('Suggested', { exact: true })).toBeVisible();
  });

  test('lights Run, and only Run, once the environment is up', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await startedProject(page);

    await expect(runButton(page)).toBeEnabled();
    await expect(page.locator('.ui-button--primary:visible')).toHaveCount(1);
    await expect(runButton(page)).toHaveClass(/ui-button--primary/);

    await stopRuntime(page, projectId);
  });

  test('runs the command it was given and shows what it printed', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await startedProject(page);

    await setCommand(page, "echo OUT''PUT-proof; echo ERR''OR-proof >&2");
    await runButton(page).click();

    await expect(page.getByText(/OUTPUT-proof/)).toBeVisible({ timeout: 60_000 });
    const error = page.getByText(/ERROR-proof/);
    await expect(error).toBeVisible({ timeout: 60_000 });
    await expect(error).toHaveClass(/stderr/);

    await expect(consoleOf(page).getByText(/^Exited with code 0/)).toBeVisible({ timeout: 30_000 });

    await stopRuntime(page, projectId);
  });

  test('reports the code a program exited with, rather than calling it done', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await startedProject(page);

    await setCommand(page, 'echo about-to-fail; exit 3');
    await runButton(page).click();

    await expect(consoleOf(page).getByText('Exited 3', { exact: true })).toBeVisible({
      timeout: 60_000,
    });

    const state = await (await page.request.get(`/api/projects/${projectId}/runtime/run`)).json();
    expect(state.status).toBe('FAILED');
    expect(state.exitCode).toBe(3);

    await stopRuntime(page, projectId);
  });

  test('keeps the output for whoever opens the console next', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await startedProject(page);

    await setCommand(page, "echo PRINTED''-BEFORE-THE-RELOAD");
    await runButton(page).click();
    await expect(page.getByText(/PRINTED-BEFORE-THE-RELOAD/)).toBeVisible({ timeout: 60_000 });

    await page.reload();

    await expect(page.getByText(/PRINTED-BEFORE-THE-RELOAD/)).toBeVisible({ timeout: 30_000 });

    await stopRuntime(page, projectId);
  });

  test('stops a program that would otherwise keep going', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await startedProject(page);

    await setCommand(page, 'sleep 600');
    await runButton(page).click();
    await expect(consoleOf(page).getByText('Running', { exact: true })).toBeVisible({
      timeout: 60_000,
    });

    await consoleOf(page).getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(consoleOf(page).getByText('Stopped', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(consoleOf(page).getByText('Stopped by you', { exact: true })).toBeVisible();

    await expect(page.locator('.runtime-chip')).toHaveText('Running');
    const state = await (await page.request.get(`/api/projects/${projectId}/runtime/run`)).json();
    expect(state.status).toBe('EXITED');

    await stopRuntime(page, projectId);
  });

  test('the preview follows the application, with nobody pressing anything', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await startedProject(page, { name: 'Run Preview' });

    await expect(page.getByText('Nothing to preview yet', { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    await setCommand(page, 'httpd -f -p 8080 -h /workspace');
    await runButton(page).click();

    await expect(page.getByText('port 8080')).toBeVisible({ timeout: 90_000 });

    await stopRuntime(page, projectId);
  });

  test('refuses an output socket opened from another page', async ({ page, request }) => {
    const projectId = await openWorkspace(page);

    const response = await request.get(`/ws/projects/${projectId}/output`, {
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
