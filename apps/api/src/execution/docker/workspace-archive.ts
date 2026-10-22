import type { Readable } from 'node:stream';
import { pack } from 'tar-stream';
import { AppError } from '../../errors/app-error.js';
import type { WorkspaceEntry } from '../provider.js';

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

export function workspaceArchive(
  entries: readonly WorkspaceEntry[],
  owner?: { uid: number; gid: number },
): Readable {
  for (const entry of entries) assertSafeArchivePath(entry.path);

  const sorted = [...entries].sort((a, b) => {
    if (a.path === b.path) return 0;
    return a.path < b.path ? -1 : 1;
  });

  const archive = pack();

  for (const entry of sorted) {
    if (entry.content === null) {
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

function ownership(owner?: { uid: number; gid: number }): { uid: number; gid: number } | object {
  return owner ? { uid: owner.uid, gid: owner.gid } : {};
}
