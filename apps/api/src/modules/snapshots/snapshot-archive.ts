import { pack, extract } from 'tar-stream';
import { AppError } from '../../errors/app-error.js';

/**
 * The archive a snapshot is stored as.
 *
 * A tar, for one reason above the others: it is not a format this project
 * invented. A snapshot is the thing somebody reaches for when everything else
 * has gone wrong, and being able to open it with tools that already exist,
 * years from now, matters more than saving a few bytes.
 *
 * Deliberately separate from the archive built for Docker in the execution
 * directory, which looks similar and answers to different requirements: that
 * one has to satisfy Docker's copy endpoint today, this one has to be readable
 * for as long as the snapshot is kept.
 */

export interface ArchiveEntry {
  path: string;
  /** Null for a directory, which is kept so an empty one survives. */
  content: Uint8Array | null;
}

/**
 * Refuses a path that would write outside the directory it is extracted into.
 *
 * The paths reaching here have already been normalised by the file service, so
 * this is the second check rather than the first. It is here because a restore
 * turns these names back into a real filesystem, and by then the archive may be
 * years old and have been somewhere else in between.
 */
export function assertSafeSnapshotPath(path: string): void {
  const problem =
    path.length === 0
      ? 'is empty'
      : path.startsWith('/') || path.startsWith('\\')
        ? 'is absolute'
        : /^[a-zA-Z]:/.test(path)
          ? 'names a drive'
          : path.split(/[\\/]/).includes('..')
            ? 'climbs out of the project'
            : path.includes('\0')
              ? 'contains a null byte'
              : undefined;

  if (problem) {
    throw new AppError('BAD_REQUEST', 'This project contains a file that cannot be archived.', {
      expose: true,
      context: { path, problem },
    });
  }
}

/**
 * Builds the whole archive in memory, as one buffer.
 *
 * In memory because the storage port takes a buffer, and because a project's
 * source is bounded by limits the file service already enforces. That bound is
 * what makes this safe, and it is the reason a snapshot of a project is not the
 * same feature as a backup of a disk.
 *
 * The listing is sorted and directories are written before what is inside them,
 * so the same files always produce the same archive. That is what makes the
 * checksum meaningful.
 */
export async function buildSnapshotArchive(
  entries: readonly ArchiveEntry[],
): Promise<{ archive: Buffer; fileCount: number }> {
  for (const entry of entries) assertSafeSnapshotPath(entry.path);

  const sorted = [...entries].sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));

  const archive = pack();
  const chunks: Buffer[] = [];
  archive.on('data', (chunk: unknown) => chunks.push(Buffer.from(chunk as Uint8Array)));

  const finished = new Promise<void>((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });

  for (const entry of sorted) {
    if (entry.content === null) {
      archive.entry({ name: `${entry.path}/`, type: 'directory', mode: 0o755 });
      continue;
    }
    archive.entry(
      { name: entry.path, size: entry.content.byteLength, mode: 0o644 },
      Buffer.from(entry.content),
    );
  }

  archive.finalize();
  await finished;

  return { archive: Buffer.concat(chunks), fileCount: sorted.length };
}

/**
 * Reads an archive back into entries.
 *
 * Not used to restore anything yet: restoring is its own task. It exists now
 * because a format nobody can read is not a format, and the only way to know
 * this one round-trips is to have the other half of it.
 */
export async function readSnapshotArchive(archive: Buffer): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  const reader = extract();

  const finished = new Promise<void>((resolve, reject) => {
    reader.on('finish', resolve);
    reader.on('error', reject);
  });

  reader.on('entry', (header, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: unknown) => chunks.push(Buffer.from(chunk as Uint8Array)));
    stream.on('end', () => {
      const path = header.name.replace(/\/$/, '');
      // Checked on the way out as well as on the way in: an archive can have
      // been somewhere else between being written and being read.
      assertSafeSnapshotPath(path);
      entries.push({
        path,
        content: header.type === 'directory' ? null : Buffer.concat(chunks),
      });
      next();
    });
    stream.resume();
  });

  reader.end(archive);
  await finished;

  return entries;
}
