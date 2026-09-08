import { describe, expect, it } from 'vitest';
import { gitEngine, type GitFile } from './git-engine.js';

/**
 * The engine against real git objects, in memory. No storage and no database:
 * what is being checked is that branching and merging do what git would.
 */

const author = { name: 'Ada', email: 'ada@users.noreply.localhost' };
const file = (path: string, text: string): GitFile => ({ path, content: Buffer.from(text) });
const text = (files: GitFile[], path: string) =>
  Buffer.from(files.find((f) => f.path === path)!.content!).toString();

async function repositoryWith(files: GitFile[]) {
  const first = await gitEngine.commit(null, files, author, 'first', null);
  return first!;
}

describe('branches', () => {
  it('starts on main and lists it', async () => {
    const repo = await repositoryWith([file('a.txt', 'one')]);
    const listed = await gitEngine.branches(repo.archive);
    expect(listed).toEqual({ current: 'main', branches: [{ name: 'main', oid: repo.oid }] });
  });

  it('creates a branch without moving the current one, then switches to it', async () => {
    const repo = await repositoryWith([file('a.txt', 'one')]);
    const withBranch = await gitEngine.createBranch(repo.archive, 'feature/x', repo.oid);

    expect((await gitEngine.branches(withBranch)).current).toBe('main');

    const switched = await gitEngine.switchBranch(withBranch, 'feature/x');
    expect(switched).toMatchObject({ branch: 'feature/x', headOid: repo.oid, commitCount: 1 });

    // A commit now lands on the branch, not on main.
    const next = await gitEngine.commit(
      switched.archive,
      [file('a.txt', 'two')],
      author,
      'on the branch',
      switched.headOid,
    );
    const listed = await gitEngine.branches(next!.archive);
    expect(listed.branches).toEqual([
      { name: 'feature/x', oid: next!.oid },
      { name: 'main', oid: repo.oid },
    ]);
  });

  it('refuses to start a branch at something that is not a commit', async () => {
    const repo = await repositoryWith([file('a.txt', 'one')]);
    await expect(gitEngine.createBranch(repo.archive, 'x', 'f'.repeat(40))).rejects.toThrow();
  });

  it('deletes a branch', async () => {
    const repo = await repositoryWith([file('a.txt', 'one')]);
    const withBranch = await gitEngine.createBranch(repo.archive, 'gone', repo.oid);
    const without = await gitEngine.deleteBranch(withBranch, 'gone');
    expect((await gitEngine.branches(without)).branches.map((b) => b.name)).toEqual(['main']);
  });
});

describe('merging', () => {
  /** main at "base", a branch with one more commit on top. */
  async function diverge(onBranch: GitFile[], onMain?: GitFile[]) {
    const base = await repositoryWith([file('a.txt', 'base'), file('b.txt', 'base')]);
    const branched = await gitEngine.switchBranch(
      await gitEngine.createBranch(base.archive, 'feature', base.oid),
      'feature',
    );
    const featured = await gitEngine.commit(
      branched.archive,
      onBranch,
      author,
      'feature work',
      base.oid,
    );
    let back = await gitEngine.switchBranch(featured!.archive, 'main');

    if (onMain) {
      const mained = await gitEngine.commit(back.archive, onMain, author, 'main work', base.oid);
      back = { ...back, archive: mained!.archive, headOid: mained!.oid };
    }
    return { base, feature: featured!, main: back };
  }

  it('fast-forwards when the current branch has nothing of its own', async () => {
    const { feature, main } = await diverge([file('a.txt', 'feature'), file('b.txt', 'base')]);

    const merged = await gitEngine.merge(main.archive, 'refs/heads/feature', author);
    expect(merged).toMatchObject({ outcome: 'fastForward', headOid: feature.oid, branch: 'main' });
    expect(text(await gitEngine.filesAt(merged.archive, merged.headOid), 'a.txt')).toBe('feature');
  });

  it('makes a merge commit when both sides changed different files', async () => {
    const { main } = await diverge(
      [file('a.txt', 'feature'), file('b.txt', 'base')],
      [file('a.txt', 'base'), file('b.txt', 'main')],
    );

    const merged = await gitEngine.merge(main.archive, 'refs/heads/feature', author);
    expect(merged.outcome).toBe('merged');

    const files = await gitEngine.filesAt(merged.archive, merged.headOid);
    expect(text(files, 'a.txt')).toBe('feature');
    expect(text(files, 'b.txt')).toBe('main');

    const [commit] = await gitEngine.history(merged.archive, 1);
    expect(commit!.parents).toHaveLength(2);
  });

  it('refuses a conflict and names the file, leaving the branch where it was', async () => {
    const { main } = await diverge(
      [file('a.txt', 'feature says this'), file('b.txt', 'base')],
      [file('a.txt', 'main says that'), file('b.txt', 'base')],
    );

    await expect(gitEngine.merge(main.archive, 'refs/heads/feature', author)).rejects.toMatchObject(
      {
        code: 'MergeConflictError',
        data: expect.objectContaining({ filepaths: ['a.txt'] }),
      },
    );
    expect(
      (await gitEngine.branches(main.archive)).branches.find((b) => b.name === 'main')!.oid,
    ).toBe(main.headOid);
  });

  it('says so when there is nothing to bring in', async () => {
    const { main } = await diverge([file('a.txt', 'feature'), file('b.txt', 'base')]);
    const once = await gitEngine.merge(main.archive, 'refs/heads/feature', author);
    const twice = await gitEngine.merge(once.archive, 'refs/heads/feature', author);
    expect(twice.outcome).toBe('upToDate');
  });
});
