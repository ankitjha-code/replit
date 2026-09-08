import type { Database } from '../../db/client.js';

/**
 * The only code that reads or writes the project_repositories table.
 *
 * One row per project, holding where the packed repository is and one cached
 * fact about it. Git itself remains the authority on its own history; nothing
 * here is a second copy of it.
 */

export interface RepositoryRecord {
  id: string;
  projectId: string;
  storageKey: string;
  branch: string;
  headOid: string | null;
  checksum: string;
  sizeBytes: number;
  commitCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export class GitRepositoryStore {
  constructor(private readonly db: Database) {}

  findByProject(projectId: string): Promise<RepositoryRecord | null> {
    return this.db.projectRepository.findUnique({ where: { projectId } });
  }

  create(input: {
    projectId: string;
    storageKey: string;
    checksum: string;
    sizeBytes: number;
    headOid: string;
    commitCount: number;
    branch?: string;
  }): Promise<RepositoryRecord> {
    return this.db.projectRepository.create({ data: input });
  }

  /**
   * Points the row at a newly written archive.
   *
   * The key changes on every commit, because each one is written beside the old
   * archive rather than over it: overwriting in place would leave a moment in
   * which the stored bytes are neither the old repository nor the new one.
   */
  update(
    id: string,
    input: {
      storageKey: string;
      checksum: string;
      sizeBytes: number;
      headOid: string;
      commitCount: number;
      branch?: string;
    },
  ): Promise<RepositoryRecord> {
    return this.db.projectRepository.update({ where: { id }, data: input });
  }

  async deleteByProject(projectId: string): Promise<void> {
    await this.db.projectRepository.deleteMany({ where: { projectId } });
  }
}

export interface RemoteRecord {
  projectId: string;
  url: string;
  username: string | null;
  /** Sealed. Opened only at the moment a request is made. */
  token: Uint8Array | null;
  lastPushedAt: Date | null;
  lastPulledAt: Date | null;
}

/** The only code that reads or writes the project_git_remotes table. */
export class GitRemoteStore {
  constructor(private readonly db: Database) {}

  find(projectId: string): Promise<RemoteRecord | null> {
    return this.db.projectGitRemote.findUnique({
      where: { projectId },
      select: {
        projectId: true,
        url: true,
        username: true,
        token: true,
        lastPushedAt: true,
        lastPulledAt: true,
      },
    });
  }

  /** `token: undefined` keeps what is stored; null removes it. */
  async save(
    projectId: string,
    input: { url: string; username: string | null; token: Uint8Array | null | undefined },
  ): Promise<void> {
    const token =
      input.token === undefined ? {} : { token: input.token as Uint8Array<ArrayBuffer> | null };
    await this.db.projectGitRemote.upsert({
      where: { projectId },
      create: { projectId, url: input.url, username: input.username, ...token },
      update: { url: input.url, username: input.username, ...token },
    });
  }

  async remove(projectId: string): Promise<void> {
    await this.db.projectGitRemote.deleteMany({ where: { projectId } });
  }

  async touch(projectId: string, what: 'pushed' | 'pulled'): Promise<void> {
    await this.db.projectGitRemote.updateMany({
      where: { projectId },
      data: what === 'pushed' ? { lastPushedAt: new Date() } : { lastPulledAt: new Date() },
    });
  }
}
