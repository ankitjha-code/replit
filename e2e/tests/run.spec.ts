import { expect, test, type Locator, type Page } from '@playwright/test';
import { openWorkspace, startedProject, stopRuntime, writeFile } from './helpers.js';

/**
 * Running a project's own application, in a real browser.
 *
 * The whole path with nothing stood in for: a command set in the workspace, a
 * process started inside the project's container, its output carried back over
 * a socket, its exit code reported, and the preview following it. Every
 * assertion reads what the platform actually said, and the program it runs is
 * the platform's own doing rather than a fixture pretending to be one.
 */

/**
 * The console's own region.
 *
 * Scoped rather than searched for across the page, because the workspace shows
 * two statuses: the container's, in the toolbar, and the application's, here.
 * They use some of the same words for different facts.
 */
function consoleOf(page: Page): Locator {
  return page.getByRole('region', { name: 'Console' });
}

/**
 * The console's Run button.
 *
 * Exact, because "Set run command" (the empty state's action) also contains
 * the word and a substring match would find both.
 */
function runButton(page: Page): Locator {
  return consoleOf(page).getByRole('button', { name: 'Run', exact: true });
}

/** Sets what the project runs, through the workspace rather than the API. */
async function setCommand(page: Page, command: string): Promise<void> {
  await consoleOf(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Run command').fill(command);
  await consoleOf(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(consoleOf(page).getByText(command, { exact: true })).toBeVisible();
}

test.describe('running an application', () => {
  test('will not run anything before the project is started', async ({ page }) => {
    // No reload anywhere in this file: the workspace learns of a file written
    // elsewhere over the project's event stream, as a person would need it to.
    const projectId = await openWorkspace(page);
    await writeFile(page, projectId, 'index.html', '<h1>hello</h1>');

    // There is a command, because the platform can tell what this project is.
    // There is nowhere to run it, and the button says so rather than failing
    // when it is pressed.
    const run = runButton(page);
    await expect(run).toBeDisabled();
    await expect(run).toHaveAttribute('title', /Start the environment/);
    await expect(
      consoleOf(page).getByText(/Start the environment before running the app/),
    ).toBeVisible();
    // Pointing at Start, never offering a second one.
    await expect(consoleOf(page).getByRole('button', { name: 'Show me' })).toBeVisible();
  });

  test('says what it would run, and where that came from', async ({ page }) => {
    const projectId = await openWorkspace(page);
    await writeFile(page, projectId, 'index.html', '<h1>hello</h1>');

    // A suggestion, labelled as one. The platform guessed this from the files
    // and has not been told it is right.
    await expect(consoleOf(page).getByTitle(/Suggested by the platform/)).toBeVisible();
    await expect(consoleOf(page).getByText('Suggested', { exact: true })).toBeVisible();
  });

  test('lights Run, and only Run, once the environment is up', async ({ page }) => {
    // Exactly one accent-filled button at any moment: Start before the
    // environment runs, then the console's Run.
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

    /*
     * Both streams arrive, and they are told apart. A log that cannot
     * distinguish an error from a progress message is a log nobody can read.
     *
     * The markers are split by quoting, so the command shown beside the button
     * contains `OUT''PUT-proof` and only the program's own output contains
     * `OUTPUT-proof`. Without that, the assertion would pass on the console
     * having repeated the command back.
     */
    await expect(page.getByText(/OUTPUT-proof/)).toBeVisible({ timeout: 60_000 });
    const error = page.getByText(/ERROR-proof/);
    await expect(error).toBeVisible({ timeout: 60_000 });
    await expect(error).toHaveClass(/stderr/);

    // And the console says the program finished, in its own words.
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

    // And the server agrees, which is the record the workspace is reading.
    const state = await (await page.request.get(`/api/projects/${projectId}/runtime/run`)).json();
    expect(state.status).toBe('FAILED');
    expect(state.exitCode).toBe(3);

    await stopRuntime(page, projectId);
  });

  test('keeps the output for whoever opens the console next', async ({ page }) => {
    // The point of holding it on the server: someone who was not watching when
    // a program crashed can still see what it said before it did.
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

    // Stopped means stopped: the container is still up, and nothing is in it.
    await expect(page.locator('.runtime-chip')).toHaveText('Running');
    const state = await (await page.request.get(`/api/projects/${projectId}/runtime/run`)).json();
    expect(state.status).toBe('EXITED');

    await stopRuntime(page, projectId);
  });

  test('the preview follows the application, with nobody pressing anything', async ({ page }) => {
    test.setTimeout(300_000);
    const projectId = await startedProject(page, { name: 'Run Preview' });

    // Before: a container with nothing serving in it, said plainly.
    await expect(page.getByText('Nothing to preview yet', { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    await setCommand(page, 'httpd -f -p 8080 -h /workspace');
    await runButton(page).click();

    // The preview finds the port on its own, because the application starting
    // is the event that changes what the project serves.
    await expect(page.getByText('port 8080')).toBeVisible({ timeout: 90_000 });

    await stopRuntime(page, projectId);
  });

  test('refuses an output socket opened from another page', async ({ page, request }) => {
    // The same attack the terminal stops, on the socket that carries output: a
    // page the person is visiting opens it, the browser attaches their cookie,
    // and that page is reading their application's log.
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
