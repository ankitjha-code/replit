import { Volume, createFsFromVolume } from 'memfs';
import git, { type AuthCallback, type HttpClient } from 'isomorphic-git';
import type { GitChange, GitCommit } from '@platform/shared';
import { buildSnapshotArchive, readSnapshotArchive } from '../snapshots/snapshot-archive.js';

/**
 * Git, in memory, with nothing running on the host.
 *
 * `isomorphic-git` is a pure JavaScript implementation, so a commit is made by
 * this process writing git objects rather than by invoking the `git` binary.
 * That is not a stylistic preference: the control plane is forbidden from
 * running commands on its host, and the ban is enforced by a lint rule over the
 * whole API. A shelling-out implementation could not have been written here at
 * all.
 *
 * The repository lives in object storage as a tar of the `.git` directory. Each
 * operation unpacks it into an in-memory filesystem, does the work, and packs it
 * back. That is more copying than a server with a disk would do, and it buys
 * something worth the cost: nothing about a project's history depends on which
 * machine happened to serve the request that wrote it.
 *
 * The cost is bounded by the same limits that bound a project's source, which
 * is the reason this is viable at all and the reason it would not be for a
 * repository with years of large binaries in it.
 */

/** Where the repository is mounted inside the in-memory filesystem. */
const ROOT = '/repo';

export interface GitFile {
  path: string;
  /** Null for a directory. Git does not track them, so they are skipped. */
  content: Uint8Array | null;
}

export interface GitAuthor {
  name: string;
  email: string;
}

/** An in-memory filesystem with a repository in it, and the git calls on it. */
interface Workspace {
  fs: ReturnType<typeof createFsFromVolume>;
}

function emptyWorkspace(): Workspace {
  const volume = new Volume();
  const fs = createFsFromVolume(volume);
  fs.mkdirSync(ROOT, { recursive: true });
  return { fs };
}

/**
 * Unpacks a stored repository, or prepares an empty one.
 *
 * The archive holds the `.git` directory only. The working tree is not stored,
 * because it is already stored: the project's files are in the database, and
 * keeping a second copy in the archive would create two answers to the question
 * of what the project contains.
 */
async function open(archive: Buffer | null): Promise<Workspace> {
  const workspace = emptyWorkspace();

  if (archive === null) {
    await git.init({ fs: workspace.fs, dir: ROOT, defaultBranch: 'main' });
    return workspace;
  }

  const entries = await readSnapshotArchive(archive);
  for (const entry of entries) {
    const full = `${ROOT}/${entry.path}`;
    if (entry.content === null) {
      workspace.fs.mkdirSync(full, { recursive: true });
      continue;
    }
    const parent = full.slice(0, full.lastIndexOf('/'));
    workspace.fs.mkdirSync(parent, { recursive: true });
    workspace.fs.writeFileSync(full, Buffer.from(entry.content));
  }

  return workspace;
}

/** Packs the `.git` directory back up, ready to be stored. */
async function pack(workspace: Workspace): Promise<Buffer> {
  const entries: { path: string; content: Uint8Array | null }[] = [];

  const walk = (relative: string): void => {
    const full = `${ROOT}/${relative}`;
    const names = workspace.fs.readdirSync(full) as unknown as string[];

    for (const name of names) {
      const childRelative = relative === '' ? name : `${relative}/${name}`;
      const childFull = `${ROOT}/${childRelative}`;
      const stat = workspace.fs.statSync(childFull);

      if (stat.isDirectory()) {
        entries.push({ path: childRelative, content: null });
        walk(childRelative);
        continue;
      }
      entries.push({
        path: childRelative,
        content: Buffer.from(workspace.fs.readFileSync(childFull) as unknown as Uint8Array),
      });
    }
  };

  walk('.git');

  const { archive } = await buildSnapshotArchive(entries);
  return archive;
}

/**
 * Writes the project's files into the working tree and stages exactly them.
 *
 * "Exactly them" is the important half. Anything git currently tracks that the
 * project no longer has is removed from the index, so a file deleted in the
 * editor becomes a deletion in the next commit rather than lingering in every
 * future one.
 */
async function stage(workspace: Workspace, files: readonly GitFile[]): Promise<void> {
  const wanted = new Set<string>();

  for (const file of files) {
    // Git does not track directories, only paths. An empty directory in a
    // project therefore has nothing to commit, which is git's behaviour and not
    // an omission here.
    if (file.content === null) continue;

    const full = `${ROOT}/${file.path}`;
    const parent = full.slice(0, full.lastIndexOf('/'));
    workspace.fs.mkdirSync(parent, { recursive: true });
    workspace.fs.writeFileSync(full, Buffer.from(file.content));
    wanted.add(file.path);
    await git.add({ fs: workspace.fs, dir: ROOT, filepath: file.path });
  }

  const tracked = await git.listFiles({ fs: workspace.fs, dir: ROOT });
  for (const path of tracked) {
    if (wanted.has(path)) continue;
    await git.remove({ fs: workspace.fs, dir: ROOT, filepath: path });
  }
}

/** Every path in a commit's tree. */
async function pathsAt(workspace: Workspace, oid: string): Promise<Map<string, string>> {
  const paths = new Map<string, string>();

  await git.walk({
    fs: workspace.fs,
    dir: ROOT,
    trees: [git.TREE({ ref: oid })],
    map: async (filepath, entries) => {
      const entry = entries?.[0];
      if (!entry || filepath === '.') return;
      if ((await entry.type()) !== 'blob') return;
      paths.set(filepath, (await entry.oid()) ?? '');
    },
  });

  return paths;
}

/** How two sets of paths differ, as added, modified and removed. */
function diffPaths(before: Map<string, string>, after: Map<string, string>): GitChange[] {
  const changes: GitChange[] = [];

  for (const [path, oid] of after) {
    const previous = before.get(path);
    if (previous === undefined) changes.push({ path, kind: 'added' });
    else if (previous !== oid) changes.push({ path, kind: 'modified' });
  }

  for (const path of before.keys()) {
    if (!after.has(path)) changes.push({ path, kind: 'removed' });
  }

  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** What the staged tree would change, against the current head. */
async function stagedChanges(workspace: Workspace, head: string | null): Promise<GitChange[]> {
  const staged = new Map<string, string>();
  const tracked = await git.listFiles({ fs: workspace.fs, dir: ROOT });

  for (const path of tracked) {
    /*
     * The blob id of what would be committed.
     *
     * Hashed from the working tree rather than read from the index, because
     * git's blob id is a pure function of the content: two files with the same
     * id are the same file, which is exactly the comparison a diff needs.
     */
    const { oid } = await git.hashBlob({
      object: Buffer.from(workspace.fs.readFileSync(`${ROOT}/${path}`) as unknown as Uint8Array),
    });
    staged.set(path, oid);
  }

  const before = head === null ? new Map<string, string>() : await pathsAt(workspace, head);
  return diffPaths(before, staged);
}

/**
 * Every file a commit's tree holds, with its content.
 *
 * The counterpart of staging: this is how a commit becomes a project again. Read
 * from git's own objects rather than from a stored working tree, because the
 * archive holds only `.git` and the objects are the authority on what a commit
 * contained.
 *
 * Directories are absent, because git does not record them. A restore from a
 * commit therefore loses an empty folder that a snapshot would have kept, which
 * is git's behaviour rather than a shortcut here.
 */
async function filesAt(workspace: Workspace, oid: string): Promise<GitFile[]> {
  const files: GitFile[] = [];

  for (const path of (await pathsAt(workspace, oid)).keys()) {
    const { blob } = await git.readBlob({ fs: workspace.fs, dir: ROOT, oid, filepath: path });
    files.push({ path, content: Buffer.from(blob) });
  }

  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** How a remote is reached, handed in so the engine never builds its own client. */
export interface RemoteAccess {
  url: string;
  http: HttpClient;
  onAuth: AuthCallback;
}

/** The branch HEAD names, and how many commits it has. */
async function headState(workspace: Workspace): Promise<{ branch: string; commitCount: number }> {
  const branch = (await git.currentBranch({ fs: workspace.fs, dir: ROOT })) ?? 'main';
  let commitCount = 0;
  try {
    commitCount = (await git.log({ fs: workspace.fs, dir: ROOT })).length;
  } catch {
    // An unborn branch has no log.
  }
  return { branch, commitCount };
}

async function tipOf(workspace: Workspace, branch: string): Promise<string> {
  return git.resolveRef({ fs: workspace.fs, dir: ROOT, ref: `refs/heads/${branch}` });
}

export interface RepositoryState {
  archive: Buffer;
  /** The branch the project's files now are. */
  branch: string;
  headOid: string;
  commitCount: number;
}

export interface CommitResult {
  archive: Buffer;
  oid: string;
  commitCount: number;
}

/** Everything the service needs from git, with the packing on either side. */
export const gitEngine = {
  /**
   * What committing the project's current files would change.
   *
   * Worked out by staging them into a throwaway copy and comparing, rather than
   * by trusting a flag: the project's files and the repository are stored
   * separately, so the only honest answer comes from looking at both.
   */
  async pendingChanges(
    archive: Buffer | null,
    files: readonly GitFile[],
    head: string | null,
  ): Promise<GitChange[]> {
    const workspace = await open(archive);
    await stage(workspace, files);
    return stagedChanges(workspace, head);
  },

  /** Makes a commit and hands back the repository to store. */
  async commit(
    archive: Buffer | null,
    files: readonly GitFile[],
    author: GitAuthor,
    message: string,
    head: string | null,
  ): Promise<CommitResult | null> {
    const workspace = await open(archive);
    await stage(workspace, files);

    const changes = await stagedChanges(workspace, head);
    // Nothing to record. Refused by the caller rather than turned into an empty
    // commit, which would make history longer without making it more useful.
    if (changes.length === 0) return null;

    const oid = await git.commit({
      fs: workspace.fs,
      dir: ROOT,
      message,
      author: { name: author.name, email: author.email },
    });

    const log = await git.log({ fs: workspace.fs, dir: ROOT });

    return { archive: await pack(workspace), oid, commitCount: log.length };
  },

  /**
   * What a commit's tree contained, ready to be written back into a project.
   *
   * Throws when the object id names nothing, which the caller turns into a
   * not-found: an id that is not there is the caller asking about a commit that
   * does not exist, not a fault.
   */
  async filesAt(archive: Buffer, oid: string): Promise<GitFile[]> {
    const workspace = await open(archive);
    // Proves the id is a commit before walking it. A tree or a blob id would
    // otherwise walk to something and produce a plausible, wrong answer.
    await git.readCommit({ fs: workspace.fs, dir: ROOT, oid });
    return filesAt(workspace, oid);
  },

  /** The history, newest first. */
  async history(archive: Buffer, limit: number): Promise<GitCommit[]> {
    const workspace = await open(archive);

    const entries = await git.log({ fs: workspace.fs, dir: ROOT, depth: limit });

    return entries.map((entry) => ({
      oid: entry.oid,
      message: entry.commit.message.trimEnd(),
      authorName: entry.commit.author.name,
      authorEmail: entry.commit.author.email,
      timestamp: entry.commit.author.timestamp,
      parents: entry.commit.parent,
    }));
  },

  /** One commit, and what it changed against its first parent. */
  async show(archive: Buffer, oid: string): Promise<{ commit: GitCommit; changes: GitChange[] }> {
    const workspace = await open(archive);

    const read = await git.readCommit({ fs: workspace.fs, dir: ROOT, oid });
    const parent = read.commit.parent[0];

    const after = await pathsAt(workspace, oid);
    const before =
      parent === undefined ? new Map<string, string>() : await pathsAt(workspace, parent);

    return {
      commit: {
        oid: read.oid,
        message: read.commit.message.trimEnd(),
        authorName: read.commit.author.name,
        authorEmail: read.commit.author.email,
        timestamp: read.commit.author.timestamp,
        parents: read.commit.parent,
      },
      changes: diffPaths(before, after),
    };
  },

  /** The current branch and every branch, each with the commit it points at. */
  async branches(
    archive: Buffer,
  ): Promise<{ current: string; branches: { name: string; oid: string }[] }> {
    const workspace = await open(archive);
    const current = (await git.currentBranch({ fs: workspace.fs, dir: ROOT })) ?? 'main';
    const names = await git.listBranches({ fs: workspace.fs, dir: ROOT });
    const branches = await Promise.all(
      names.sort().map(async (name) => ({ name, oid: await tipOf(workspace, name) })),
    );
    return { current, branches };
  },

  /**
   * A new branch at a commit. Nothing about the project's files changes: this
   * names a point in history, and switching to it is a separate step.
   */
  async createBranch(archive: Buffer, name: string, from: string): Promise<Buffer> {
    const workspace = await open(archive);
    await git.readCommit({ fs: workspace.fs, dir: ROOT, oid: from });
    await git.branch({ fs: workspace.fs, dir: ROOT, ref: name, object: from, checkout: false });
    return pack(workspace);
  },

  async deleteBranch(archive: Buffer, name: string): Promise<Buffer> {
    const workspace = await open(archive);
    await git.deleteBranch({ fs: workspace.fs, dir: ROOT, ref: name });
    return pack(workspace);
  },

  /**
   * Points HEAD at another branch.
   *
   * Only the reference moves. The working tree here is thrown away with the
   * in-memory filesystem; the project's files are the working tree, and the
   * caller writes the branch's files into them.
   */
  async switchBranch(archive: Buffer, name: string): Promise<RepositoryState> {
    const workspace = await open(archive);
    const headOid = await tipOf(workspace, name);
    await git.writeRef({
      fs: workspace.fs,
      dir: ROOT,
      ref: 'HEAD',
      value: `refs/heads/${name}`,
      symbolic: true,
      force: true,
    });
    const { commitCount } = await headState(workspace);
    return { archive: await pack(workspace), branch: name, headOid, commitCount };
  },

  /**
   * Brings another branch — or a fetched remote branch — into the current one.
   *
   * A fast-forward when possible and a merge commit when not. Conflicts are
   * refused rather than written: there is no working tree here to leave markers
   * in, and a merge the platform half-did would be worse than one it declined.
   * The error carries the conflicting paths, so somebody can resolve them.
   */
  async merge(
    archive: Buffer,
    theirs: string,
    author: GitAuthor,
  ): Promise<RepositoryState & { outcome: 'fastForward' | 'merged' | 'upToDate' }> {
    const workspace = await open(archive);
    const ours = (await git.currentBranch({ fs: workspace.fs, dir: ROOT })) ?? 'main';

    const result = await git.merge({
      fs: workspace.fs,
      dir: ROOT,
      ours,
      theirs,
      author: { name: author.name, email: author.email },
      message: `Merge ${theirs.replace(/^refs\/(heads|remotes)\//, '')} into ${ours}`,
      fastForward: true,
      abortOnConflict: true,
    });

    const headOid = result.oid ?? (await tipOf(workspace, ours));
    const { commitCount } = await headState(workspace);
    return {
      archive: await pack(workspace),
      branch: ours,
      headOid,
      commitCount,
      outcome: result.alreadyMerged ? 'upToDate' : result.fastForward ? 'fastForward' : 'merged',
    };
  },

  /**
   * Fetches one branch of a remote.
   *
   * Into an existing repository the result lands at `refs/remotes/origin/…` for
   * a merge to bring in. Into no repository at all, it becomes the repository:
   * the remote's branch is adopted as the local one, which is how a project is
   * imported from somewhere else.
   */
  async fetch(
    archive: Buffer | null,
    remote: RemoteAccess,
    branch: string | null,
  ): Promise<{ archive: Buffer; remoteRef: string; adopted: RepositoryState | null }> {
    const workspace = await open(archive);
    await git.addRemote({
      fs: workspace.fs,
      dir: ROOT,
      remote: 'origin',
      url: remote.url,
      force: true,
    });

    const fetched = await git.fetch({
      fs: workspace.fs,
      http: remote.http,
      dir: ROOT,
      remote: 'origin',
      url: remote.url,
      ...(branch ? { ref: branch, remoteRef: branch } : {}),
      singleBranch: true,
      tags: false,
      onAuth: remote.onAuth,
    });

    const name = branch ?? fetched.defaultBranch?.replace(/^refs\/heads\//, '') ?? 'main';
    if (!fetched.fetchHead) {
      throw Object.assign(new Error(`The remote has no branch called ${name}.`), {
        code: 'NotFoundError',
      });
    }

    if (archive !== null) {
      return {
        archive: await pack(workspace),
        remoteRef: `refs/remotes/origin/${name}`,
        adopted: null,
      };
    }

    await git.writeRef({
      fs: workspace.fs,
      dir: ROOT,
      ref: `refs/heads/${name}`,
      value: fetched.fetchHead,
      force: true,
    });
    await git.writeRef({
      fs: workspace.fs,
      dir: ROOT,
      ref: 'HEAD',
      value: `refs/heads/${name}`,
      symbolic: true,
      force: true,
    });
    // The unborn default branch `init` made is not a branch anybody asked for.
    if (name !== 'main') {
      await git
        .deleteRef({ fs: workspace.fs, dir: ROOT, ref: 'refs/heads/main' })
        .catch(() => undefined);
    }

    const { commitCount } = await headState(workspace);
    const packed = await pack(workspace);
    return {
      archive: packed,
      remoteRef: `refs/remotes/origin/${name}`,
      adopted: { archive: packed, branch: name, headOid: fetched.fetchHead, commitCount },
    };
  },

  /** Sends the current branch to the same-named branch on the remote. */
  async push(archive: Buffer, remote: RemoteAccess, force: boolean): Promise<Buffer> {
    const workspace = await open(archive);
    const branch = (await git.currentBranch({ fs: workspace.fs, dir: ROOT })) ?? 'main';
    await git.addRemote({
      fs: workspace.fs,
      dir: ROOT,
      remote: 'origin',
      url: remote.url,
      force: true,
    });

    const result = await git.push({
      fs: workspace.fs,
      http: remote.http,
      dir: ROOT,
      remote: 'origin',
      url: remote.url,
      ref: branch,
      remoteRef: branch,
      force,
      onAuth: remote.onAuth,
    });

    if (!result.ok) {
      throw Object.assign(new Error(result.error ?? 'The remote refused the push.'), {
        code: 'PushRejectedError',
      });
    }
    return pack(workspace);
  },
};
