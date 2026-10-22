import type { Readable } from 'node:stream';
import { extract } from 'tar-stream';
import { isExcludedFromSync } from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import type { WorkspaceFile } from '../provider.js';

export interface ReadWorkspaceOptions {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  applyExclusions: boolean;
}

export interface ReadWorkspaceOutcome {
  files: WorkspaceFile[];
  oversized: string[];
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

export function archiveRoot(workspacePath: string): string {
  const segments = workspacePath.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];

  if (!last) {
    throw new AppError('INTERNAL_ERROR', 'The workspace path is not usable', {
      context: { workspacePath },
    });
  }

  return last;
}

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
