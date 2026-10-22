import { joinPath, parentOf, type FileEntry } from '@platform/shared';
import { fetchFileContent } from '../../lib/files-api.js';

/**
 * "app.js" -> "app copy.js", then "app copy 2.js", skipping names in use.
 *
 * Checked against the tree on screen. Writing without a version would replace
 * a file that appeared since, so the name is picked to be new rather than
 * trusted to be.
 */
export function copyPathFor(path: string, entries: readonly FileEntry[]): string {
  const taken = new Set(entries.map((entry) => entry.path));
  const directory = parentOf(path);
  const name = path.split('/').pop() ?? path;
  // A leading dot is part of the name (".env"), not an extension.
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';

  for (let attempt = 1; ; attempt++) {
    const suffix = attempt === 1 ? ' copy' : ` copy ${attempt}`;
    const candidate = joinPath(directory, `${stem}${suffix}${extension}`);
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The folders an entry may be moved into: the root, then every folder that is
 * not the entry itself, inside it, or where it already is.
 */
export function moveTargets(path: string, entries: readonly FileEntry[]): string[] {
  const current = parentOf(path);
  const folders = entries
    .filter((entry) => entry.type === 'DIRECTORY')
    .map((entry) => entry.path)
    .filter((folder) => folder !== path && !folder.startsWith(`${path}/`));
  return ['', ...folders].filter((folder) => folder !== current);
}

/** Saves one project file to the person's device. */
export async function saveToDevice(projectId: string, path: string): Promise<void> {
  const file = await fetchFileContent(projectId, path);
  const blob =
    file.encoding === 'base64'
      ? new Blob([Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0))])
      : new Blob([file.content], { type: 'text/plain;charset=utf-8' });

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = path.split('/').pop() ?? path;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked later: some browsers start reading the URL after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
