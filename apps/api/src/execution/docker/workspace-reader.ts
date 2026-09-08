import type { Readable } from 'node:stream';
import { extract } from 'tar-stream';
import { isExcludedFromSync } from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import type { WorkspaceFile } from '../provider.js';

/**
 * Reads a container's workspace out as a list of files.
 *
 * Docker hands back a tar of the directory, named after the directory itself,
 * so every entry arrives with a prefix that has to come off before the paths
 * mean anything to the project.
 *
 * The excluded paths are dropped **while the archive is being read**, not
 * afterwards. A workspace with dependencies installed in it is routinely a
 * hundred thousand files and several hundred megabytes; holding all of that in
 * memory to filter it later is the difference between reading a project back
 * and running the control plane out of memory.
 */

export interface ReadWorkspaceOptions {
  /** Largest single file to carry back. Anything above it is skipped. */
  maxFileBytes: number;
  /** Ceiling on everything carried back, so one workspace cannot exhaust memory. */
  maxTotalBytes: number;
  /** Ceiling on how many files are carried back. */
  maxFiles: number;
  /**
   * Whether to drop the paths a project never wants read back.
   *
   * True when reading a workspace into a project, which is what the exclusion
   * list is for: `node_modules` and `.git` belong in the container.
   *
   * False when collecting a build's output, where the same list would be
   * actively wrong — `dist` and `build` are on it, and they are precisely what
   * a static build produces. The caller named one directory and wants what is
   * in it.
   */
  applyExclusions: boolean;
}

export interface ReadWorkspaceOutcome {
  files: WorkspaceFile[];
  /** Paths left behind because they were too large to carry. */
  oversized: string[];
  /**
   * True when a ceiling stopped the read early.
   *
   * Reported rather than swallowed: a partial answer presented as a complete
   * one would have the platform delete files it simply never read.
   */
  truncated: boolean;
}

export async function readWorkspaceArchive(
  archive: Readable,
  root: string,
  options: ReadWorkspaceOptions,
): Promise<ReadWorkspaceOutcome> {
  const files: WorkspaceFile[] = [];
  const oversized: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  const extractor = extract();

  extractor.on('entry', (header, stream, next) => {
    const path = stripRoot(header.name, root);

    // Only regular files. A directory is implied by the paths inside it, and a
    // symbolic link read back into a database is a path pretending to be
    // content.
    const usable =
      header.type === 'file' &&
      path !== undefined &&
      (!options.applyExclusions || !isExcludedFromSync(path));

    if (!usable) {
      stream.on('end', next);
      stream.resume();
      return;
    }

    const size = header.size ?? 0;

    if (size > options.maxFileBytes) {
      oversized.push(path);
      stream.on('end', next);
      stream.resume();
      return;
    }

    if (files.length >= options.maxFiles || totalBytes + size > options.maxTotalBytes) {
      truncated = true;
      stream.on('end', next);
      stream.resume();
      return;
    }

    const chunks: Buffer[] = [];
    stream.on('data', (chunk: unknown) => {
      chunks.push(chunk as Buffer);
    });
    stream.on('end', () => {
      const content = Buffer.concat(chunks);
      totalBytes += content.byteLength;
      files.push({ path, content });
      next();
    });
  });

  await new Promise<void>((resolve, reject) => {
    extractor.on('finish', resolve);
    extractor.on('error', reject);
    archive.on('error', reject);
    archive.pipe(extractor);
  });

  return { files, oversized, truncated };
}

/**
 * Removes the directory name Docker puts in front of every entry.
 *
 * Returns undefined for anything outside that directory, or for a path that
 * climbs out of it. The archive comes from a container, which is to say from
 * code the platform did not write, and a path from there is input.
 */
export function stripRoot(name: string, root: string): string | undefined {
  const normalised = name.replace(/\\/g, '/').replace(/\/+$/, '');
  const prefix = `${root}/`;

  const relative =
    normalised === root
      ? ''
      : normalised.startsWith(prefix)
        ? normalised.slice(prefix.length)
        : undefined;

  if (relative === undefined || relative.length === 0) return undefined;
  if (relative.startsWith('/')) return undefined;
  if (relative.split('/').includes('..')) return undefined;
  if (relative.includes('\0')) return undefined;

  return relative;
}

/** The last segment of a container path, which is what Docker names the archive. */
export function archiveRoot(workspacePath: string): string {
  const segments = workspacePath.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];

  if (!last) {
    // A workspace at the filesystem root would make every path ambiguous.
    throw new AppError('INTERNAL_ERROR', 'The workspace path is not usable', {
      context: { workspacePath },
    });
  }

  return last;
}

/**
 * Joins a directory onto the workspace path, refusing anything that climbs out.
 *
 * The directory comes from a project's deployment configuration, which is text
 * somebody typed. It becomes a path inside a container, and the shared schema
 * already refuses a traversal on the way in; this is the second check, at the
 * point where it would actually matter.
 */
export function containerPath(workspacePath: string, directory: string): string {
  const trimmed = directory.replace(/^\.\/+/, '').replace(/\/+$/, '');

  if (trimmed === '' || trimmed === '.') return workspacePath;

  const segments = trimmed.split('/').filter((segment) => segment.length > 0);

  if (segments.some((segment) => segment === '..') || trimmed.startsWith('/')) {
    throw new AppError('BAD_REQUEST', 'That output directory is not inside the project.', {
      expose: true,
      context: { directory },
    });
  }

  return `${workspacePath}/${segments.join('/')}`;
}
