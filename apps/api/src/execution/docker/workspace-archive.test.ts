import { extract } from 'tar-stream';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../errors/app-error.js';
import { assertSafeArchivePath, workspaceArchive } from './workspace-archive.js';
import type { WorkspaceEntry } from '../provider.js';

/**
 * The archive a project is copied into a container as.
 *
 * Docker extracts this onto a real filesystem, so an entry that names its way
 * out of the target directory is a container escape written as a file name.
 * That is what most of this file is about.
 */

const file = (path: string, text = 'x'): WorkspaceEntry => ({
  path,
  content: new TextEncoder().encode(text),
});

const directory = (path: string): WorkspaceEntry => ({ path, content: null });

/** Reads an archive back into the entries it contains. */
async function read(entries: readonly WorkspaceEntry[]) {
  const found: { name: string; type: string; body: string }[] = [];
  const extractor = extract();

  extractor.on('entry', (header, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: unknown) => {
      chunks.push(chunk as Buffer);
    });
    stream.on('end', () => {
      found.push({
        name: header.name,
        type: String(header.type),
        body: Buffer.concat(chunks).toString('utf8'),
      });
      next();
    });
    stream.resume();
  });

  await new Promise<void>((resolve, reject) => {
    extractor.on('finish', resolve);
    extractor.on('error', reject);
    workspaceArchive(entries).pipe(extractor);
  });

  return found;
}

describe('refusing a path that would escape the workspace', () => {
  const rejected = [
    ['an absolute path', '/etc/passwd'],
    ['a Windows absolute path', 'C:\\Windows\\system32'],
    ['a backslash root', '\\etc\\passwd'],
    ['a parent segment', '../outside.txt'],
    ['a parent segment in the middle', 'src/../../outside.txt'],
    ['a parent segment with backslashes', 'src\\..\\..\\outside.txt'],
    ['a null byte', 'a\0b.txt'],
    ['an empty path', ''],
  ] as const;

  for (const [description, path] of rejected) {
    it(`refuses ${description}`, () => {
      expect(() => assertSafeArchivePath(path)).toThrow(AppError);
    });
  }

  it('refuses the whole archive rather than skipping the bad entry', () => {
    // Copying most of a project and silently dropping one file would leave
    // someone debugging a missing import.
    expect(() => workspaceArchive([file('index.js'), file('../escape.js')])).toThrow(AppError);
  });

  it('says nothing about the host in the message', () => {
    try {
      assertSafeArchivePath('../../etc/passwd');
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).message).toBe(
        'This project contains a file that cannot be copied.',
      );
      // The offending path is kept for the log, not for the response.
      expect((error as AppError).context?.path).toBe('../../etc/passwd');
    }
  });

  it('allows the ordinary paths a project is made of', () => {
    for (const path of ['index.js', 'src/app.ts', 'a/b/c/d.txt', '.env.example', 'a..b/c.txt']) {
      expect(() => assertSafeArchivePath(path)).not.toThrow();
    }
  });
});

describe('what the archive contains', () => {
  it('carries a file and its bytes', async () => {
    const found = await read([file('index.js', 'console.log(1)')]);
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe('index.js');
    expect(found[0]?.body).toBe('console.log(1)');
  });

  it('keeps an empty directory, which someone created on purpose', async () => {
    const found = await read([directory('src')]);
    expect(found[0]?.name).toBe('src/');
    expect(found[0]?.type).toBe('directory');
  });

  it('keeps an empty file as an empty file', async () => {
    const found = await read([{ path: 'empty.txt', content: new Uint8Array() }]);
    expect(found[0]?.body).toBe('');
  });

  it('writes a directory before what is inside it', async () => {
    const found = await read([file('src/app.ts'), directory('src')]);
    expect(found.map((entry) => entry.name)).toEqual(['src/', 'src/app.ts']);
  });

  it('produces the same archive whatever order the entries arrive in', async () => {
    // Which is what will let an unchanged project skip the copy later.
    const forwards = await read([file('a.js'), file('b.js'), file('c.js')]);
    const backwards = await read([file('c.js'), file('b.js'), file('a.js')]);
    expect(forwards).toEqual(backwards);
  });

  it('carries bytes that are not text', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const found = await read([{ path: 'logo.png', content: bytes }]);
    expect(Buffer.from(found[0]!.body, 'utf8').length).toBeGreaterThan(0);
  });
});
