import { describe, expect, it } from 'vitest';
import type { FileEntry } from '@platform/shared';
import { ancestorsOf, buildTree, flattenVisible } from './build-tree.js';

const entry = (path: string, type: 'FILE' | 'DIRECTORY' = 'FILE'): FileEntry => ({
  path,
  name: path.split('/').pop()!,
  type,
  size: type === 'FILE' ? 1 : 0,
  isBinary: false,
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const paths = (nodes: ReturnType<typeof buildTree>): string[] =>
  nodes.map((node) => node.entry.path);

describe('buildTree', () => {
  it('nests entries under their directory', () => {
    const roots = buildTree([entry('src', 'DIRECTORY'), entry('src/a.ts'), entry('b.ts')]);

    expect(paths(roots)).toEqual(['src', 'b.ts']);
    expect(paths(roots[0]!.children)).toEqual(['src/a.ts']);
  });

  it('nests to any depth', () => {
    const roots = buildTree([
      entry('a', 'DIRECTORY'),
      entry('a/b', 'DIRECTORY'),
      entry('a/b/c.ts'),
    ]);

    expect(paths(roots[0]!.children[0]!.children)).toEqual(['a/b/c.ts']);
  });

  it('puts directories before files, then sorts by name', () => {
    const roots = buildTree([
      entry('z.ts'),
      entry('a.ts'),
      entry('beta', 'DIRECTORY'),
      entry('alpha', 'DIRECTORY'),
    ]);

    expect(paths(roots)).toEqual(['alpha', 'beta', 'a.ts', 'z.ts']);
  });

  it('sorts numerically, so file10 follows file9', () => {
    const roots = buildTree([entry('file10.ts'), entry('file9.ts'), entry('file1.ts')]);
    expect(paths(roots)).toEqual(['file1.ts', 'file9.ts', 'file10.ts']);
  });

  it('keeps an empty directory', () => {
    // People make them on purpose, so one has to survive the round trip.
    const roots = buildTree([entry('empty', 'DIRECTORY')]);
    expect(paths(roots)).toEqual(['empty']);
    expect(roots[0]!.children).toEqual([]);
  });

  it('shows an entry whose parent is missing rather than dropping it', () => {
    // Writes create their ancestors, so this should not happen. Losing a file
    // from the display would be a far worse failure than showing it at the top.
    const roots = buildTree([entry('orphan/deep/file.ts')]);
    expect(paths(roots)).toEqual(['orphan/deep/file.ts']);
  });

  it('does not nest under a parent that is a file', () => {
    const roots = buildTree([entry('notes.txt'), entry('notes.txt/inner.ts')]);
    expect(roots).toHaveLength(2);
  });

  it('handles an empty project', () => {
    expect(buildTree([])).toEqual([]);
  });
});

describe('flattenVisible', () => {
  const roots = buildTree([
    entry('src', 'DIRECTORY'),
    entry('src/a.ts'),
    entry('src/deep', 'DIRECTORY'),
    entry('src/deep/b.ts'),
    entry('root.ts'),
  ]);

  it('hides what is inside a collapsed directory', () => {
    const rows = flattenVisible(roots, new Set());
    expect(rows.map((row) => row.node.entry.path)).toEqual(['src', 'root.ts']);
  });

  it('reveals one level at a time', () => {
    const rows = flattenVisible(roots, new Set(['src']));
    // Directories come before files at every level, so "src/deep" precedes
    // "src/a.ts" despite the alphabet.
    expect(rows.map((row) => row.node.entry.path)).toEqual([
      'src',
      'src/deep',
      'src/a.ts',
      'root.ts',
    ]);
  });

  it('reveals a nested directory when both are open', () => {
    const rows = flattenVisible(roots, new Set(['src', 'src/deep']));
    expect(rows.map((row) => row.node.entry.path)).toEqual([
      'src',
      'src/deep',
      'src/deep/b.ts',
      'src/a.ts',
      'root.ts',
    ]);
  });

  it('reports depth, so a row can be indented', () => {
    const rows = flattenVisible(roots, new Set(['src', 'src/deep']));
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 1, 0]);
  });

  it('follows what the eye follows', () => {
    // Keyboard navigation moves between rows as drawn, so the order here has
    // to be the order on screen.
    const rows = flattenVisible(roots, new Set(['src']));
    expect(rows[0]?.node.entry.path).toBe('src');
    expect(rows[rows.length - 1]?.node.entry.path).toBe('root.ts');
  });
});

describe('ancestorsOf', () => {
  it('lists every containing directory', () => {
    expect(ancestorsOf('a/b/c/d.ts')).toEqual(['a/b/c', 'a/b', 'a']);
  });

  it('returns nothing for a top-level path', () => {
    expect(ancestorsOf('index.ts')).toEqual([]);
  });
});
