import { expect, type Page } from '@playwright/test';

/**
 * What the browser specs do before they do anything of their own.
 *
 * One copy of the steps, and of the labels they press, so a change to the
 * shell's wording is a change here and nowhere else. Each helper does exactly
 * what the specs did for themselves before they shared this: nothing waits
 * for more, or for less, than it did.
 */

export function uniqueIdentity() {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    email: `e2e-${suffix}@example.test`,
    username: `e2e-${suffix}`,
    password: 'analytical-engine-1843',
  };
}

export type Identity = ReturnType<typeof uniqueIdentity>;

/**
 * Signs up and waits until the browser is actually signed in.
 *
 * Returning as soon as the button is clicked would let the next step race the
 * request, which is exactly the kind of flake that makes a suite untrustworthy.
 */
export async function signUp(page: Page, identity: Identity = uniqueIdentity()): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Email', { exact: true }).fill(identity.email);
  await page.getByLabel('Username', { exact: true }).fill(identity.username);
  await page.getByLabel('Password', { exact: true }).fill(identity.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expectSignedIn(page);
}

/**
 * Waits until the shell shows a signed-in account.
 *
 * The one place that knows which control proves it, so the specs assert
 * "signed in" rather than the name of a button the shell may move.
 */
export async function expectSignedIn(page: Page): Promise<void> {
  await expect(accountMenuTrigger(page)).toBeVisible();
}

/** Signs out through the account menu. Does not wait for the signed-out page. */
export async function signOut(page: Page): Promise<void> {
  // The workspace carries the menu in its own toolbar once that lands; until
  // then, and on any page without the header, the projects list always has it.
  if (!(await accountMenuTrigger(page).isVisible())) {
    await page.goto('/');
  }
  await accountMenuTrigger(page).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
}

/**
 * The account menu's button. Its accessible name is the username, which a
 * helper does not know, so it is found by the class the shell keeps for this
 * purpose (src/shell/AccountMenu.tsx). The same control sits in the header and
 * in the workspace toolbar.
 */
function accountMenuTrigger(page: Page) {
  return page.locator('.account-menu__trigger');
}

/** Submits the sign-in form. Does not assume it succeeds. */
export async function signIn(page: Page, identifier: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email or username', { exact: true }).fill(identifier);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Creates a project from the list, whichever button the list is offering. */
export async function createProject(page: Page, name: string): Promise<void> {
  const start = page.getByRole('button', { name: 'Create your first project' });
  if (await start.isVisible().catch(() => false)) {
    await start.click();
  } else {
    await page.getByRole('button', { name: 'New project' }).click();
  }

  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
}

/** Signs up, creates a project, opens its workspace, and returns the project's id. */
export async function openWorkspace(page: Page, name = 'Workspace Test'): Promise<string> {
  await signUp(page);
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await expect(page.getByRole('region', { name: 'Files' })).toBeVisible();
  return page.url().split('/projects/')[1]!;
}

/** Writes a file through the API, which carries the browser's session. */
export async function writeFile(
  page: Page,
  projectId: string,
  path: string,
  content = '{}',
): Promise<void> {
  const response = await page.request.put(`/api/projects/${projectId}/files/content`, {
    data: { path, content, encoding: 'utf8' },
  });
  expect(response.status()).toBe(200);
}

/**
 * Presses Start and waits for the container to be up.
 *
 * The image may need pulling the first time this runs on a machine, hence the
 * generous wait.
 */
export async function startRuntime(page: Page): Promise<void> {
  // A file written a moment ago reaches the workspace over the event stream
  // and is detected a beat later. Start is usable before that (it asks which
  // language to use), so wait for the detection rather than open that dialog.
  // "Ready" means the state has loaded (the chip no longer says Checking)
  // and the title is not the picker's, which it is only while nothing is
  // detected and nothing has run before.
  const chip = page.locator('.runtime-chip');
  await expect
    .poll(
      async () => {
        const [text, title] = await Promise.all([chip.textContent(), chip.getAttribute('title')]);
        if (!text || /Checking/.test(text)) return 'loading';
        if (!title || /^Choose what this project runs/.test(title)) return 'undetected';
        return 'ready';
      },
      { timeout: 15_000 },
    )
    .toBe('ready');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('.runtime-chip')).toHaveText('Running', { timeout: 280_000 });
}

/**
 * A project with a container up, ready to be run in.
 *
 * The static runtime: its image is the smallest in the catalogue, and the
 * shell inside it can be told to do anything a test needs. The page is written
 * through the API and the workspace learns of it over the project's own event
 * stream: there is no reload, because a person would not have one.
 */
export async function startedProject(
  page: Page,
  options: { name?: string; marker?: string } = {},
): Promise<string> {
  const projectId = await openWorkspace(page, options.name);
  await writeFile(page, projectId, 'index.html', `<h1>${options.marker ?? 'hello'}</h1>`);
  await startRuntime(page);
  return projectId;
}

/** Leaves nothing running behind a test. */
export async function stopRuntime(page: Page, projectId: string): Promise<void> {
  await page.request.post(`/api/projects/${projectId}/runtime/stop`, { data: {} });
}

/**
 * Brings the shell tab forward.
 *
 * The console opens on the application's output, because that is what pressing
 * Run produces. The terminal is the other tab, and nothing is mounted for it
 * until it is chosen.
 */
export async function openShell(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Shell', exact: true }).click();
}

/** The file explorer's own region. */
export const explorer = (page: Page) => page.getByRole('region', { name: 'Files' });

/** A pattern matching the final segment of a path, escaped for a regex. */
export function leafOf(path: string): RegExp {
  const leaf = path.split('/').pop() ?? path;
  return new RegExp(leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/**
 * Creates a file and waits until the reloaded tree shows it.
 *
 * Returning as soon as the key is pressed would let the next step act against
 * a tree that is about to be replaced, which loses focus and makes the suite
 * flaky for reasons that have nothing to do with the code.
 */
export async function newFile(page: Page, name: string): Promise<void> {
  await explorer(page).getByRole('button', { name: 'New file' }).click();
  await page.getByLabel(/New file name/).fill(name);
  await page.getByLabel(/New file name/).press('Enter');
  await expect(page.getByRole('treeitem', { name: leafOf(name) })).toBeVisible();
}

/** Opens a file from the explorer and waits for Monaco to be ready. */
export async function openFile(page: Page, name: string): Promise<void> {
  await page.getByRole('treeitem', { name: new RegExp(name.split('.')[0]!) }).click();
  // Monaco is several megabytes and loads on demand, so the first open is slow.
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 });
}

/**
 * The text Monaco has painted.
 *
 * Read from the line container rather than by querying for the whole string,
 * because Monaco splits a line across one element per syntax token and no
 * single element holds the sentence. Monaco paints non-breaking spaces so that
 * runs of spaces are not collapsed by the browser; they are ordinary spaces in
 * the buffer.
 */
export async function editorText(page: Page): Promise<string> {
  const painted = (await page.locator('.monaco-editor .view-lines').first().textContent()) ?? '';
  return painted.replaceAll(String.fromCharCode(0x00a0), ' ');
}
