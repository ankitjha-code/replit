import { describe, expect, it } from 'vitest';
import {
  baseName,
  detectFileKind,
  extensionOf,
  isInside,
  joinPath,
  languageOf,
  normalizePath,
  parentOf,
} from './files.js';

describe('path normalisation', () => {
  it('accepts ordinary project-relative paths', () => {
    for (const path of ['index.js', 'src/index.ts', 'a/b/c/d.txt', '.gitignore', 'a.b.c']) {
      expect(normalizePath(path)).toEqual({ ok: true, path });
    }
  });

  it('collapses duplicate and trailing separators', () => {
    // The only rewriting done, because neither can change what a path means.
    expect(normalizePath('src//index.ts').path).toBe('src/index.ts');
    expect(normalizePath('src/').path).toBe('src');
    expect(normalizePath('a///b//c/').path).toBe('a/b/c');
  });

  it('refuses traversal rather than resolving it', () => {
    // Resolving ".." would mean deciding what someone meant by escaping the
    // project root, and the only correct answer is to refuse.
    for (const path of ['../secrets', 'src/../../etc/passwd', 'a/./b', '..', '.']) {
      expect(normalizePath(path)).toMatchObject({ ok: false, problem: 'traversal' });
    }
  });

  it('refuses absolute paths', () => {
    expect(normalizePath('/etc/passwd')).toMatchObject({ ok: false, problem: 'absolute' });
    expect(normalizePath('C:/Windows')).toMatchObject({ ok: false, problem: 'absolute' });
    expect(normalizePath('C:\\Windows')).toMatchObject({ ok: false, problem: 'absolute' });
  });

  it('refuses a backslash, which is a separator on some hosts', () => {
    expect(normalizePath('src\\index.ts')).toMatchObject({
      ok: false,
      problem: 'forbidden-character',
    });
  });

  it('refuses control characters and null bytes', () => {
    expect(normalizePath('a\u0000b')).toMatchObject({ ok: false, problem: 'forbidden-character' });
    expect(normalizePath('a\nb')).toMatchObject({ ok: false, problem: 'forbidden-character' });
  });

  it('refuses characters that are reserved on Windows', () => {
    for (const path of ['a:b', 'a?b', 'a*b', 'a|b', 'a<b', 'a>b', 'a"b']) {
      expect(normalizePath(path)).toMatchObject({ ok: false, problem: 'forbidden-character' });
    }
  });

  it('refuses names Windows resolves as devices', () => {
    for (const path of ['con', 'NUL.txt', 'src/COM1', 'lpt9.js']) {
      expect(normalizePath(path)).toMatchObject({ ok: false, problem: 'reserved-name' });
    }
  });

  it('refuses a trailing space or dot, which some hosts drop silently', () => {
    for (const path of ['name ', 'name.', 'src/thing ', ' leading']) {
      expect(normalizePath(path)).toMatchObject({
        ok: false,
        problem: 'trailing-space-or-dot',
      });
    }
  });

  it('refuses an empty path', () => {
    expect(normalizePath('')).toMatchObject({ ok: false, problem: 'empty' });
    expect(normalizePath('/')).toMatchObject({ ok: false, problem: 'absolute' });
  });

  it('bounds the whole path and each segment', () => {
    expect(normalizePath('a'.repeat(256))).toMatchObject({
      ok: false,
      problem: 'segment-too-long',
    });

    const deep = Array.from({ length: 20 }, () => 'a'.repeat(100)).join('/');
    expect(normalizePath(deep)).toMatchObject({ ok: false, problem: 'too-long' });
  });

  it('never returns a path that would escape the root', () => {
    const attempts = [
      '../x',
      'a/../../x',
      '/x',
      'a/..',
      './x',
      'a/./b',
      '\\x',
      'a\\..\\b',
      'C:\\x',
    ];

    for (const attempt of attempts) {
      const result = normalizePath(attempt);
      if (result.ok) {
        expect(result.path).not.toContain('..');
        expect(result.path?.startsWith('/')).toBe(false);
      }
    }
  });

  it('accepts unicode names', () => {
    // Restricting to ASCII would be a different and unnecessary rule.
    expect(normalizePath('src/café.ts')).toEqual({ ok: true, path: 'src/café.ts' });
    expect(normalizePath('日本語.md')).toEqual({ ok: true, path: '日本語.md' });
  });
});

describe('path helpers', () => {
  it('finds the parent directory, and the root for a top-level path', () => {
    expect(parentOf('src/index.ts')).toBe('src');
    expect(parentOf('a/b/c.txt')).toBe('a/b');
    expect(parentOf('index.ts')).toBe('');
  });

  it('finds the final segment', () => {
    expect(baseName('src/index.ts')).toBe('index.ts');
    expect(baseName('index.ts')).toBe('index.ts');
  });

  it('joins a directory and a name, treating the root as empty', () => {
    expect(joinPath('src', 'index.ts')).toBe('src/index.ts');
    expect(joinPath('', 'index.ts')).toBe('index.ts');
  });

  it('requires a separator when deciding containment', () => {
    // Otherwise "src" would appear to contain "srcfile.ts".
    expect(isInside('src', 'src/index.ts')).toBe(true);
    expect(isInside('src', 'srcfile.ts')).toBe(false);
    expect(isInside('', 'anything')).toBe(true);
  });
});

describe('file type detection', () => {
  it('reads the extension', () => {
    expect(extensionOf('src/index.ts')).toBe('ts');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('README')).toBe('');
  });

  it('treats a leading dot as part of the name, not an extension', () => {
    expect(extensionOf('.gitignore')).toBe('');
  });

  it('maps common source extensions to a language', () => {
    expect(languageOf('a.ts')).toBe('typescript');
    expect(languageOf('a.py')).toBe('python');
    expect(languageOf('a.json')).toBe('json');
  });

  it('recognises files named by convention rather than extension', () => {
    expect(languageOf('Dockerfile')).toBe('dockerfile');
    expect(languageOf('Makefile')).toBe('makefile');
  });

  it('falls back to plain text rather than guessing', () => {
    expect(languageOf('mystery.xyz')).toBe('plaintext');
    expect(detectFileKind('mystery.xyz').mime).toBe('text/plain');
  });

  it('reports a media type for images', () => {
    expect(detectFileKind('logo.png').mime).toBe('image/png');
    expect(detectFileKind('icon.svg').mime).toBe('image/svg+xml');
  });
});
