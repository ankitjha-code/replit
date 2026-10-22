import { Volume, createFsFromVolume } from 'memfs';
import git, { type AuthCallback, type HttpClient } from 'isomorphic-git';
import type { GitChange, GitCommit } from '@platform/shared';
import { buildSnapshotArchive, readSnapshotArchive } from '../snapshots/snapshot-archive.js';

const ROOT = '/repo';

export interface GitFile {
  path: string;
  content: Uint8Array | null;
}

export interface GitAuthor {
  name: string;
  email: string;
}

interface Workspace {
  fs: ReturnType<typeof createFsFromVolume>;
}

function emptyWorkspace(): Workspace {
  const volume = new Volume();
  const fs = createFsFromVolume(volume);
  fs.mkdirSync(ROOT, { recursive: true });
  return { fs };
}

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

async function stage(workspace: Workspace, files: readonly GitFile[]): Promise<void> {
  const wanted = new Set<string>();

  for (const file of files) {
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

async function stagedChanges(workspace: Workspace, head: string | null): Promise<GitChange[]> {
  const staged = new Map<string, string>();
  const tracked = await git.listFiles({ fs: workspace.fs, dir: ROOT });

  for (const path of tracked) {
    const { oid } = await git.hashBlob({
      object: Buffer.from(workspace.fs.readFileSync(`${ROOT}/${path}`) as unknown as Uint8Array),
    });
    staged.set(path, oid);
  }

  const before = head === null ? new Map<string, string>() : await pathsAt(workspace, head);
  return diffPaths(before, staged);
}

async function filesAt(workspace: Workspace, oid: string): Promise<GitFile[]> {
  const files: GitFile[] = [];

  for (const path of (await pathsAt(workspace, oid)).keys()) {
    const { blob } = await git.readBlob({ fs: workspace.fs, dir: ROOT, oid, filepath: path });
    files.push({ path, content: Buffer.from(blob) });
  }

  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface RemoteAccess {
  url: string;
  http: HttpClient;
  onAuth: AuthCallback;
}

async function headState(workspace: Workspace): Promise<{ branch: string; commitCount: number }> {
  const branch = (await git.currentBranch({ fs: workspace.fs, dir: ROOT })) ?? 'main';
  let commitCount = 0;
  try {
    commitCount = (await git.log({ fs: workspace.fs, dir: ROOT })).length;
  } catch {}
  return { branch, commitCount };
}

async function tipOf(workspace: Workspace, branch: string): Promise<string> {
  return git.resolveRef({ fs: workspace.fs, dir: ROOT, ref: `refs/heads/${branch}` });
}

export interface RepositoryState {
  archive: Buffer;
  branch: string;
  headOid: string;
  commitCount: number;
}

export interface CommitResult {
  archive: Buffer;
  oid: string;
  commitCount: number;
}

export const gitEngine = {
  async pendingChanges(
    archive: Buffer | null,
    files: readonly GitFile[],
    head: string | null,
  ): Promise<GitChange[]> {
    const workspace = await open(archive);
    await stage(workspace, files);
    return stagedChanges(workspace, head);
  },

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

  async filesAt(archive: Buffer, oid: string): Promise<GitFile[]> {
    const workspace = await open(archive);
    await git.readCommit({ fs: workspace.fs, dir: ROOT, oid });
    return filesAt(workspace, oid);
  },

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
