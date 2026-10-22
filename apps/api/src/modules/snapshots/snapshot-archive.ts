import { pack, extract } from 'tar-stream';
import { AppError } from '../../errors/app-error.js';

export interface ArchiveEntry {
  path: string;
  content: Uint8Array | null;
}

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
