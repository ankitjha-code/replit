import type { Readable } from 'node:stream';
import { pack } from 'tar-stream';
import { describe, expect, it } from 'vitest';
import { archiveRoot, readWorkspaceArchive, stripRoot } from './workspace-reader.js';

const limits = {
  maxFileBytes: 1_000,
  maxTotalBytes: 10_000,
  maxFiles: 100,
  applyExclusions: true,
};

function archive(
  entries: { name: string; body?: string; type?: 'file' | 'directory' | 'symlink' }[],
): Readable {
  const tar = pack();

  for (const entry of entries) {
    const body = entry.body ?? '';
    if (entry.type && entry.type !== 'file') {
      tar.entry({ name: entry.name, type: entry.type, linkname: 'elsewhere' });
      continue;
    }
    tar.entry({ name: entry.name, size: Buffer.byteLength(body) }, Buffer.from(body));
  }

  tar.finalize();
  return tar as unknown as Readable;
}

const read = (entries: Parameters<typeof archive>[0], options: Partial<typeof limits> = {}) =>
  readWorkspaceArchive(archive(entries), 'workspace', { ...limits, ...options });

describe('stripping the directory Docker names the archive after', () => {
  it('removes the prefix from a path inside it', () => {
    expect(stripRoot('workspace/src/app.ts', 'workspace')).toBe('src/app.ts');
  });

  it('refuses the directory itself, which is not a file', () => {
    expect(stripRoot('workspace', 'workspace')).toBeUndefined();
    expect(stripRoot('workspace/', 'workspace')).toBeUndefined();
  });

  it('refuses anything outside it', () => {
    expect(stripRoot('etc/passwd', 'workspace')).toBeUndefined();
    expect(stripRoot('workspace-other/file', 'workspace')).toBeUndefined();
  });

  it('refuses a name that climbs out', () => {
    expect(stripRoot('workspace/../../etc/passwd', 'workspace')).toBeUndefined();
    expect(stripRoot('workspace/a/../../b', 'workspace')).toBeUndefined();
  });

  it('refuses a null byte', () => {
    expect(stripRoot('workspace/a\0b', 'workspace')).toBeUndefined();
  });

  it('names the archive after the last segment of the workspace path', () => {
    expect(archiveRoot('/workspace')).toBe('workspace');
    expect(archiveRoot('/home/project/src')).toBe('src');
  });
});

describe('what is carried back', () => {
  it('carries a file and its bytes', async () => {
    const outcome = await read([{ name: 'workspace/index.js', body: 'console.log(1)' }]);

    expect(outcome.files).toHaveLength(1);
    expect(outcome.files[0]?.path).toBe('index.js');
    expect(Buffer.from(outcome.files[0]!.content).toString()).toBe('console.log(1)');
  });

  it('carries nested paths', async () => {
    const outcome = await read([{ name: 'workspace/src/lib/util.ts', body: 'x' }]);
    expect(outcome.files[0]?.path).toBe('src/lib/util.ts');
  });

  it('leaves directories behind, because the paths imply them', async () => {
    const outcome = await read([
      { name: 'workspace/src', type: 'directory' },
      { name: 'workspace/src/a.ts', body: 'a' },
    ]);

    expect(outcome.files.map((file) => file.path)).toEqual(['src/a.ts']);
  });

  it('leaves symbolic links behind', async () => {
    const outcome = await read([{ name: 'workspace/link', type: 'symlink' }]);
    expect(outcome.files).toEqual([]);
  });

  it('drops excluded paths while reading, not afterwards', async () => {
    const outcome = await read([
      { name: 'workspace/node_modules/react/index.js', body: 'big' },
      { name: 'workspace/.git/HEAD', body: 'ref' },
      { name: 'workspace/index.js', body: 'mine' },
    ]);

    expect(outcome.files.map((file) => file.path)).toEqual(['index.js']);
  });
});

describe('limits', () => {
  it('leaves behind a file larger than the ceiling, and names it', async () => {
    const outcome = await read([
      { name: 'workspace/huge.bin', body: 'x'.repeat(2_000) },
      { name: 'workspace/small.txt', body: 'ok' },
    ]);

    expect(outcome.oversized).toEqual(['huge.bin']);
    expect(outcome.files.map((file) => file.path)).toEqual(['small.txt']);
    expect(outcome.truncated).toBe(false);
  });

  it('reports being cut short by a total size ceiling', async () => {
    const outcome = await read(
      [
        { name: 'workspace/a.txt', body: 'x'.repeat(600) },
        { name: 'workspace/b.txt', body: 'x'.repeat(600) },
      ],
      { maxTotalBytes: 1_000 },
    );

    expect(outcome.truncated).toBe(true);
  });

  it('reports being cut short by a file count ceiling', async () => {
    const outcome = await read(
      [
        { name: 'workspace/a.txt', body: 'a' },
        { name: 'workspace/b.txt', body: 'b' },
        { name: 'workspace/c.txt', body: 'c' },
      ],
      { maxFiles: 2 },
    );

    expect(outcome.truncated).toBe(true);
    expect(outcome.files).toHaveLength(2);
  });

  it('says nothing was cut short when nothing was', async () => {
    const outcome = await read([{ name: 'workspace/a.txt', body: 'a' }]);
    expect(outcome.truncated).toBe(false);
  });
});
