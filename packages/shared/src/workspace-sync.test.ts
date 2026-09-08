import { describe, expect, it } from 'vitest';
import {
  isExcludedFromSync,
  SYNC_EXCLUDED_DIRECTORIES,
  workspaceSyncResultSchema,
} from './workspace-sync.js';

/**
 * What comes back from a container and what stays in it.
 *
 * The exclusion list is the difference between reading a project back and
 * trying to put a hundred thousand dependency files into a database.
 */

describe('what stays in the container', () => {
  it('leaves installed dependencies behind', () => {
    expect(isExcludedFromSync('node_modules/react/index.js')).toBe(true);
    expect(isExcludedFromSync('node_modules')).toBe(true);
  });

  it('leaves them behind wherever they are, not only at the root', () => {
    // A workspace with several packages has one of these inside each.
    expect(isExcludedFromSync('packages/web/node_modules/react/index.js')).toBe(true);
    expect(isExcludedFromSync('a/b/c/__pycache__/mod.pyc')).toBe(true);
  });

  it('leaves behind everything on the list', () => {
    for (const directory of SYNC_EXCLUDED_DIRECTORIES) {
      expect(isExcludedFromSync(`${directory}/something`)).toBe(true);
    }
  });

  it('leaves behind what the platform already stores or can rebuild', () => {
    expect(isExcludedFromSync('.git/HEAD')).toBe(true);
    expect(isExcludedFromSync('dist/main.js')).toBe(true);
    expect(isExcludedFromSync('coverage/index.html')).toBe(true);
  });

  it('leaves behind files that belong to an operating system', () => {
    expect(isExcludedFromSync('.DS_Store')).toBe(true);
    expect(isExcludedFromSync('src/Thumbs.db')).toBe(true);
  });

  it('leaves nothing behind for an empty path', () => {
    expect(isExcludedFromSync('')).toBe(true);
  });
});

describe('what comes back', () => {
  it('brings back the code someone wrote', () => {
    for (const path of ['index.js', 'src/app.ts', 'a/b/c.py', 'README.md']) {
      expect(isExcludedFromSync(path)).toBe(false);
    }
  });

  it('brings back dotfiles that are part of a project', () => {
    // These are written on purpose and belong to the project.
    for (const path of ['.gitignore', '.env.example', '.nvmrc', '.eslintrc.json']) {
      expect(isExcludedFromSync(path)).toBe(false);
    }
  });

  it('does not confuse a name that merely contains an excluded one', () => {
    expect(isExcludedFromSync('my-node_modules-notes.md')).toBe(false);
    expect(isExcludedFromSync('src/distribution.ts')).toBe(false);
    expect(isExcludedFromSync('buildings/plan.txt')).toBe(false);
  });
});

describe('the result of a sync', () => {
  it('counts every outcome, including nothing changing', () => {
    const parsed = workspaceSyncResultSchema.parse({
      created: 2,
      updated: 1,
      deleted: 0,
      unchanged: 40,
      skipped: [{ path: 'node_modules/x', reason: 'excluded' }],
      skippedTruncated: false,
    });

    expect(parsed.unchanged).toBe(40);
    expect(parsed.skipped[0]?.reason).toBe('excluded');
  });

  it('refuses a skip with no reason given', () => {
    const parsed = workspaceSyncResultSchema.safeParse({
      created: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      skipped: [{ path: 'big.bin' }],
      skippedTruncated: false,
    });
    expect(parsed.success).toBe(false);
  });
});
