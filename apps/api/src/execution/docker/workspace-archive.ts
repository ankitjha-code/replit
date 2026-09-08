import type { Readable } from 'node:stream';
import { pack } from 'tar-stream';
import { AppError } from '../../errors/app-error.js';
import type { WorkspaceEntry } from '../provider.js';

/**
 * Builds the tar the project's files are copied into a container as.
 *
 * Docker's copy endpoint takes a tar and extracts it relative to a target
 * directory. That makes the archive a filesystem write, and an entry naming
 * `../../etc/passwd` would land outside the workspace. The paths reaching here
 * have already been normalised by the file service, so this is the second
 * check rather than the first: it is the last thing between stored bytes and a
 * real filesystem, and the cost of being wrong here is the whole container.
 */

/** Refuses anything that could write outside the directory it is extracted into. */
export function assertSafeArchivePath(path: string): void {
  const problem =
    path.length === 0
      ? 'is empty'
      : path.startsWith('/') || path.startsWith('\\')
        ? 'is absolute'
        : /^[a-zA-Z]:/.test(path)
          ? 'names a drive'
          : path.split(/[\\/]/).includes('..')
            ? 'climbs out of the workspace'
            : path.includes('\0')
              ? 'contains a null byte'
              : undefined;

  if (problem) {
    throw new AppError('EXECUTION_FAILED', 'This project contains a file that cannot be copied.', {
      expose: true,
      context: { path, problem },
    });
  }
}

/**
 * A tar of the whole workspace.
 *
 * Directories are written before the files inside them and the whole listing
 * is sorted, so the same project always produces the same archive. That is
 * what will later let a copy be skipped when nothing has changed.
 */
export function workspaceArchive(
  entries: readonly WorkspaceEntry[],
  /**
   * Who the extracted files belong to.
   *
   * Set on every entry rather than fixed up afterwards, because the extraction
   * happens as root inside the daemon and this is the only moment ownership can
   * be decided for free. Without it every file lands owned by root and a
   * non-root workload cannot edit its own project.
   *
   * Undefined leaves them owned by root, which is what an installation running
   * workloads as root wants.
   */
  owner?: { uid: number; gid: number },
): Readable {
  for (const entry of entries) assertSafeArchivePath(entry.path);

  const sorted = [...entries].sort((a, b) => {
    if (a.path === b.path) return 0;
    // A directory sorts before anything beneath it, which is also what a
    // sensible extraction order needs.
    return a.path < b.path ? -1 : 1;
  });

  const archive = pack();

  for (const entry of sorted) {
    if (entry.content === null) {
      // A directory entry carries no body, and tar-stream closes it itself.
      archive.entry({
        name: `${entry.path}/`,
        type: 'directory',
        mode: 0o755,
        ...ownership(owner),
      });
      continue;
    }
    archive.entry(
      { name: entry.path, size: entry.content.byteLength, mode: 0o644, ...ownership(owner) },
      Buffer.from(entry.content),
    );
  }

  archive.finalize();
  return archive as unknown as Readable;
}

/** Tar ownership fields, or nothing at all when the workload runs as root. */
function ownership(owner?: { uid: number; gid: number }): { uid: number; gid: number } | object {
  return owner ? { uid: owner.uid, gid: owner.gid } : {};
}
