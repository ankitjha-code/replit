import { createHash, randomUUID } from 'node:crypto';
import {
  commitMessageSchema,
  type GitCommit,
  type GitCommitDetailResponse,
  type GitRemote,
  type GitStateResponse,
  type MergeResult,
  type SetGitRemoteRequest,
} from '@platform/shared';
import type { AuthCallback } from 'isomorphic-git';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { ProjectEventPublisher } from '../../events/project-event-bus.js';
import type { StorageProvider } from '../../storage/provider.js';
import type { FileService, ProjectFileExport } from '../files/file.service.js';
import type { SecretBox } from '../../lib/secret-box.js';
import {
  gitEngine,
  type GitAuthor,
  type GitFile,
  type RemoteAccess,
  type RepositoryState,
} from './git-engine.js';
import type { GitRemoteStore, GitRepositoryStore, RepositoryRecord } from './git.repository.js';
import {
  checkRemoteUrl,
  createRemoteHttp,
  RemoteRefusedError,
  type RemoteHttpOptions,
} from './remote-http.js';

/**
 * A change to the project's files that git has worked out and not yet made.
 *
 * Switching, merging and pulling all change both the repository and the
 * project's files, and those are two stores. The plan holds the new repository
 * in memory and the files it implies; the caller — the restore service, which
 * is the one place allowed to write a project's files — writes them, then calls
 * `apply` to store the repository. Files first: if storing the repository then
 * fails, the project shows uncommitted changes, and nothing is lost, because
 * every plan starts from a project with nothing uncommitted.
 */
export interface GitPlan {
  /** The files the project will have, or null when they do not change. */
  entries: ProjectFileExport[] | null;
  apply(): Promise<void>;
  headOid: string;
  outcome: MergeResult['outcome'] | 'switched' | 'imported';
}

/**
 * A project's git history.
 *
 * The platform holds a project's files in its own database and its history in a
 * git repository beside them. Those are two stores, and everything awkward here
 * comes from that: the answer to "is there anything to commit" has to be worked
 * out by comparing them, because neither one knows about the other.
 *
 * The alternative, making git the store for the files as well, would mean every
 * keystroke in the editor touching a repository. Autosave writes constantly, and
 * a commit per save is not history, it is noise with hashes on it.
 */

export interface GitServiceOptions {
  /** How much history a listing returns at once. */
  historyLimit: number;
  /** The largest packed repository this installation will store. */
  maxRepositoryBytes: number;
}

export class GitService {
  constructor(
    private readonly repositories: GitRepositoryStore,
    private readonly files: FileService,
    private readonly storage: StorageProvider,
    private readonly options: GitServiceOptions,
    private readonly log: Logger,
  ) {}

  /**
   * Where commits are announced, when there is anywhere to announce them. Set
   * after construction, as the file service's is.
   */
  private events: ProjectEventPublisher | undefined;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }

  /**
   * Why git cannot be used here, or null when it can.
   *
   * The repository is kept in object storage, so an installation without one
   * says so rather than offering a history it has nowhere to write.
   */
  unavailableReason(): Promise<string | null> {
    return this.storage.unavailableReason();
  }

  /**
   * The history, and whether anything is waiting to go into it.
   *
   * The pending changes are computed rather than remembered. The project's files
   * and the repository are separate stores, so the only honest answer comes from
   * comparing what is in one against what is in the other.
   */
  async describe(projectId: string): Promise<GitStateResponse> {
    const [record, unavailableReason] = await Promise.all([
      this.repositories.findByProject(projectId),
      this.unavailableReason(),
    ]);

    if (unavailableReason) {
      return {
        initialized: record !== null,
        commits: [],
        hasUncommittedChanges: false,
        pendingChanges: [],
        unavailableReason,
        branch: record?.branch ?? 'main',
        branches: [],
      };
    }

    const archive = record ? await this.fetchArchive(record) : null;
    const files = await this.projectFiles(projectId);

    const pendingChanges = await gitEngine.pendingChanges(archive, files, record?.headOid ?? null);
    const commits = archive ? await gitEngine.history(archive, this.options.historyLimit) : [];
    const listed = archive ? await gitEngine.branches(archive) : null;

    return {
      initialized: record !== null,
      commits,
      hasUncommittedChanges: pendingChanges.length > 0,
      pendingChanges,
      unavailableReason: null,
      branch: listed?.current ?? record?.branch ?? 'main',
      branches: (listed?.branches ?? []).map((branch) => ({
        name: branch.name,
        headOid: branch.oid,
        current: branch.name === listed?.current,
      })),
    };
  }

  /**
   * Records the project's current files as a commit.
   *
   * The author is the signed-in account and is never taken from the request. An
   * author line a caller could choose is a signature that means nothing, and
   * git will happily write whatever it is given.
   */
  async commit(
    projectId: string,
    author: GitAuthor,
    rawMessage: string,
  ): Promise<GitStateResponse> {
    const message = this.requireValidMessage(rawMessage);

    const reason = await this.storage.unavailableReason();
    if (reason) throw new AppError('SERVICE_UNAVAILABLE', reason, { expose: true });

    const record = await this.repositories.findByProject(projectId);
    const archive = record ? await this.fetchArchive(record) : null;
    const files = await this.projectFiles(projectId);

    const result = await gitEngine.commit(archive, files, author, message, record?.headOid ?? null);

    if (result === null) {
      throw new AppError(
        'PRECONDITION_FAILED',
        'Nothing has changed since the last commit, so there is nothing to record.',
      );
    }

    await this.store(projectId, record, {
      archive: result.archive,
      branch: record?.branch ?? 'main',
      headOid: result.oid,
      commitCount: result.commitCount,
    });

    this.log.info({ projectId, oid: result.oid }, 'commit recorded');
    return this.describe(projectId);
  }

  /** One commit, and what it changed. */
  async show(projectId: string, oid: string): Promise<GitCommitDetailResponse> {
    const record = await this.repositories.findByProject(projectId);
    if (!record) throw new AppError('NOT_FOUND', 'This project has no history yet');

    const archive = await this.fetchArchive(record);

    try {
      return await gitEngine.show(archive, oid);
    } catch {
      // An object id that names nothing is a not-found, not a server fault:
      // it is the caller asking about a commit that is not there.
      throw new AppError('NOT_FOUND', 'There is no commit with that identifier');
    }
  }

  /**
   * The files a commit contained, ready to be written back into a project.
   *
   * Reading a commit is reading history, so it needs nothing more than the
   * capability that lists it. Writing those files into the project is a separate
   * decision made by the restore service, behind a separate capability.
   */
  async readCommitFiles(
    projectId: string,
    oid: string,
  ): Promise<{ commit: GitCommit; entries: ProjectFileExport[] }> {
    const record = await this.repositories.findByProject(projectId);
    if (!record) throw new AppError('NOT_FOUND', 'This project has no history yet');

    const archive = await this.fetchArchive(record);

    let files;
    let commit;
    try {
      commit = (await gitEngine.show(archive, oid)).commit;
      files = await gitEngine.filesAt(archive, oid);
    } catch {
      throw new AppError('NOT_FOUND', 'There is no commit with that identifier');
    }

    return {
      commit,
      entries: files.map((file) => ({ path: file.path, content: file.content })),
    };
  }

  // -------------------------------------------------------------------------
  // Branches

  /** A new branch, at the current head or a named commit. The project's files do not change. */
  async createBranch(projectId: string, name: string, from?: string): Promise<GitStateResponse> {
    const record = await this.requireRepository(projectId);
    const archive = await this.fetchArchive(record);
    const listed = await gitEngine.branches(archive);

    if (listed.branches.some((branch) => branch.name === name)) {
      throw new AppError('CONFLICT', `There is already a branch called ${name}.`, { expose: true });
    }

    let next: Buffer;
    try {
      next = await gitEngine.createBranch(archive, name, from ?? record.headOid ?? '');
    } catch {
      throw new AppError('NOT_FOUND', 'There is no commit with that identifier');
    }

    await this.store(projectId, record, {
      archive: next,
      branch: record.branch,
      headOid: record.headOid ?? '',
      commitCount: record.commitCount,
    });
    this.log.info({ projectId, branch: name }, 'branch created');
    return this.describe(projectId);
  }

  async deleteBranch(projectId: string, name: string): Promise<GitStateResponse> {
    const record = await this.requireRepository(projectId);
    const archive = await this.fetchArchive(record);
    const listed = await gitEngine.branches(archive);

    if (name === listed.current) {
      throw new AppError(
        'PRECONDITION_FAILED',
        'That is the branch the project is on. Switch to another one first.',
      );
    }
    if (!listed.branches.some((branch) => branch.name === name)) {
      throw new AppError('NOT_FOUND', `There is no branch called ${name}.`);
    }

    await this.store(projectId, record, {
      archive: await gitEngine.deleteBranch(archive, name),
      branch: record.branch,
      headOid: record.headOid ?? '',
      commitCount: record.commitCount,
    });
    this.log.info({ projectId, branch: name }, 'branch deleted');
    return this.describe(projectId);
  }

  /** Works out a switch to another branch. See `GitPlan` for why it is two steps. */
  async planSwitch(projectId: string, name: string): Promise<GitPlan> {
    const record = await this.requireRepository(projectId);
    const archive = await this.fetchArchive(record);
    await this.requireNothingUncommitted(projectId, archive, record, 'switching branches');

    const listed = await gitEngine.branches(archive);
    if (!listed.branches.some((branch) => branch.name === name)) {
      throw new AppError('NOT_FOUND', `There is no branch called ${name}.`);
    }

    const state = await gitEngine.switchBranch(archive, name);
    const files = await gitEngine.filesAt(state.archive, state.headOid);

    return {
      entries: files.map((file) => ({ path: file.path, content: file.content })),
      headOid: state.headOid,
      outcome: 'switched',
      apply: async () => {
        await this.store(projectId, record, state);
        this.log.info({ projectId, branch: name }, 'switched branch');
      },
    };
  }

  /** Works out bringing another branch into the current one. */
  async planMerge(projectId: string, branch: string, author: GitAuthor): Promise<GitPlan> {
    const record = await this.requireRepository(projectId);
    const archive = await this.fetchArchive(record);
    await this.requireNothingUncommitted(projectId, archive, record, 'merging');

    const listed = await gitEngine.branches(archive);
    if (branch === listed.current) {
      throw new AppError('PRECONDITION_FAILED', 'A branch cannot be merged into itself.');
    }
    if (!listed.branches.some((entry) => entry.name === branch)) {
      throw new AppError('NOT_FOUND', `There is no branch called ${branch}.`);
    }

    return this.mergePlan(projectId, record, archive, `refs/heads/${branch}`, author);
  }

  // -------------------------------------------------------------------------
  // Remotes

  private remotes: GitRemoteStore | undefined;
  private box: SecretBox | undefined;
  private remoteHttp: RemoteHttpOptions | undefined;

  useRemotes(remotes: GitRemoteStore, box: SecretBox | undefined, http: RemoteHttpOptions): void {
    this.remotes = remotes;
    this.box = box;
    this.remoteHttp = http;
  }

  /** The remote, as anybody allowed to see history may see it: never the token. */
  async remote(projectId: string): Promise<GitRemote | null> {
    const record = await this.requireRemotes().find(projectId);
    if (!record) return null;
    return {
      url: record.url,
      username: record.username,
      hasToken: record.token !== null,
      lastPushedAt: record.lastPushedAt?.toISOString() ?? null,
      lastPulledAt: record.lastPulledAt?.toISOString() ?? null,
    };
  }

  async setRemote(projectId: string, input: SetGitRemoteRequest): Promise<GitRemote> {
    const remotes = this.requireRemotes();
    try {
      checkRemoteUrl(input.url, this.remoteHttp!);
    } catch (error) {
      throw new AppError('VALIDATION_FAILED', 'That address cannot be used', {
        details: {
          fields: [
            { path: 'url', message: error instanceof Error ? error.message : 'Invalid address' },
          ],
        },
      });
    }

    let token: Uint8Array | null | undefined;
    if (input.token === undefined) token = undefined;
    else if (input.token === '') token = null;
    else {
      if (!this.box) {
        throw new AppError(
          'SERVICE_UNAVAILABLE',
          'This installation has no encryption key, so it cannot keep a token.',
          { expose: true },
        );
      }
      token = this.box.seal(input.token);
    }

    await remotes.save(projectId, {
      url: input.url,
      username: input.username?.trim() ? input.username.trim() : null,
      token,
    });
    this.log.info({ projectId, host: new URL(input.url).host }, 'git remote set');
    return (await this.remote(projectId))!;
  }

  async removeRemote(projectId: string): Promise<void> {
    await this.requireRemotes().remove(projectId);
    this.log.info({ projectId }, 'git remote removed');
  }

  /** Sends the current branch to the remote. Refused, not forced, when the remote is ahead. */
  async push(projectId: string, force: boolean): Promise<GitStateResponse> {
    const record = await this.requireRepository(projectId);
    const access = await this.remoteAccess(projectId);
    const archive = await this.fetchArchive(record);

    const next = await this.talkToRemote(() => gitEngine.push(archive, access, force));

    await this.store(projectId, record, {
      archive: next,
      branch: record.branch,
      headOid: record.headOid ?? '',
      commitCount: record.commitCount,
    });
    await this.requireRemotes().touch(projectId, 'pushed');
    this.log.info({ projectId, branch: record.branch, force }, 'pushed to remote');
    return this.describe(projectId);
  }

  /**
   * Works out a pull: the remote's copy of the current branch, merged in.
   *
   * With no history here yet, the remote's history becomes this project's —
   * importing a repository is a pull into nothing.
   */
  async planPull(projectId: string, author: GitAuthor): Promise<GitPlan> {
    const access = await this.remoteAccess(projectId);
    const record = await this.repositories.findByProject(projectId);

    if (!record) {
      const files = await this.projectFiles(projectId);
      if (files.some((file) => file.content !== null)) {
        throw new AppError(
          'PRECONDITION_FAILED',
          'This project has files and no history. Commit them first, so pulling cannot overwrite them without a record.',
        );
      }

      const fetched = await this.talkToRemote(() => gitEngine.fetch(null, access, null));
      const state = fetched.adopted!;
      const imported = await gitEngine.filesAt(state.archive, state.headOid);

      return {
        entries: imported.map((file) => ({ path: file.path, content: file.content })),
        headOid: state.headOid,
        outcome: 'imported',
        apply: async () => {
          await this.store(projectId, null, state);
          await this.requireRemotes().touch(projectId, 'pulled');
          this.log.info({ projectId, branch: state.branch }, 'imported from remote');
        },
      };
    }

    const archive = await this.fetchArchive(record);
    await this.requireNothingUncommitted(projectId, archive, record, 'pulling');

    const fetched = await this.talkToRemote(() => gitEngine.fetch(archive, access, record.branch));
    const plan = await this.mergePlan(
      projectId,
      record,
      fetched.archive,
      fetched.remoteRef,
      author,
    );

    return {
      ...plan,
      apply: async () => {
        await plan.apply();
        await this.requireRemotes().touch(projectId, 'pulled');
      },
    };
  }

  /**
   * Removes a project's repository, for when the project is going.
   *
   * Deliberately does not throw. A project must stay deletable when the object
   * store is unreachable, so a failure is logged as a leak rather than turned
   * into a project nobody can remove.
   */
  async releaseProject(projectId: string): Promise<void> {
    const record = await this.repositories.findByProject(projectId);
    if (!record) return;

    await this.storage.delete(record.storageKey).catch((error: unknown) => {
      this.log.error(
        { err: error, projectId, storageKey: record.storageKey },
        'a repository archive could not be removed and is now orphaned',
      );
    });

    await this.repositories.deleteByProject(projectId);
    this.events?.publish(projectId, { type: 'history.changed', headOid: null });
  }

  // -------------------------------------------------------------------------

  /**
   * Writes a repository beside the old one, points the row at it, then removes
   * the old one.
   *
   * Overwriting in place would mean a moment where the stored bytes are neither
   * the old repository nor the new one, and a failure in that moment loses the
   * whole history. Writing beside it and switching the row is the version where
   * the worst outcome is a leaked object.
   */
  private async store(
    projectId: string,
    record: RepositoryRecord | null,
    state: RepositoryState,
  ): Promise<void> {
    if (state.archive.byteLength > this.options.maxRepositoryBytes) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        'This repository has grown past what this installation will store.',
      );
    }

    const storageKey = `repositories/${projectId}/${randomUUID()}.tar`;
    const checksum = createHash('sha256').update(state.archive).digest('hex');

    await this.storage.put(storageKey, state.archive, 'application/x-tar');

    const fields = {
      storageKey,
      checksum,
      sizeBytes: state.archive.byteLength,
      headOid: state.headOid,
      commitCount: state.commitCount,
      branch: state.branch,
    };

    try {
      if (record) await this.repositories.update(record.id, fields);
      else await this.repositories.create({ projectId, ...fields });
    } catch (error) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }

    // Only once the row points at the new object. Until then the old one is
    // still the repository.
    if (record) {
      await this.storage.delete(record.storageKey).catch((error: unknown) => {
        this.log.error(
          { err: error, projectId, storageKey: record.storageKey },
          'a superseded repository archive could not be removed and is now orphaned',
        );
      });
    }

    this.events?.publish(projectId, { type: 'history.changed', headOid: state.headOid });
  }

  private async mergePlan(
    projectId: string,
    record: RepositoryRecord,
    archive: Buffer,
    theirs: string,
    author: GitAuthor,
  ): Promise<GitPlan> {
    let merged;
    try {
      merged = await gitEngine.merge(archive, theirs, author);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'MergeConflictError') {
        const paths = (error as { data?: { filepaths?: string[] } }).data?.filepaths ?? [];
        throw new AppError(
          'CONFLICT',
          `These files were changed on both sides and cannot be merged automatically: ${paths.join(', ')}. Resolve them on one branch and try again.`,
          { expose: true, details: { conflicts: paths } },
        );
      }
      if (code === 'MergeNotSupportedError' || code === 'MissingNameError') {
        throw new AppError(
          'PRECONDITION_FAILED',
          'These histories have nothing in common, so they cannot be merged here.',
        );
      }
      throw error;
    }

    const changed = merged.outcome !== 'upToDate';
    const files = changed ? await gitEngine.filesAt(merged.archive, merged.headOid) : null;

    return {
      entries: files ? files.map((file) => ({ path: file.path, content: file.content })) : null,
      headOid: merged.headOid,
      outcome: merged.outcome,
      apply: async () => {
        await this.store(projectId, record, merged);
        this.log.info({ projectId, theirs, outcome: merged.outcome }, 'merged');
      },
    };
  }

  /**
   * Refuses to move the files while any are not committed.
   *
   * Switching, merging and pulling replace the project's files with a commit's.
   * Anything not committed would simply vanish, so the answer is "commit first",
   * which is what git itself says.
   */
  private async requireNothingUncommitted(
    projectId: string,
    archive: Buffer,
    record: RepositoryRecord,
    doing: string,
  ): Promise<void> {
    const pending = await gitEngine.pendingChanges(
      archive,
      await this.projectFiles(projectId),
      record.headOid,
    );
    if (pending.length > 0) {
      throw new AppError(
        'PRECONDITION_FAILED',
        `Commit your changes before ${doing}: ${String(pending.length)} ${pending.length === 1 ? 'file differs' : 'files differ'} from the last commit.`,
        { expose: true, details: { pending: pending.map((change) => change.path) } },
      );
    }
  }

  private async requireRepository(projectId: string): Promise<RepositoryRecord> {
    const reason = await this.storage.unavailableReason();
    if (reason) throw new AppError('SERVICE_UNAVAILABLE', reason, { expose: true });

    const record = await this.repositories.findByProject(projectId);
    if (!record) throw new AppError('NOT_FOUND', 'This project has no history yet');
    return record;
  }

  private requireRemotes(): GitRemoteStore {
    if (!this.remotes || !this.remoteHttp) throw new Error('Git was built without remotes');
    return this.remotes;
  }

  /** The stored remote, ready to be talked to, with its token opened only now. */
  private async remoteAccess(projectId: string): Promise<RemoteAccess> {
    const record = await this.requireRemotes().find(projectId);
    if (!record) {
      throw new AppError('PRECONDITION_FAILED', 'This project has no remote. Add one first.');
    }

    const token = record.token && this.box ? this.box.open(record.token) : null;
    let attempts = 0;
    const onAuth: AuthCallback = () => {
      // Asked again after a refusal means the credentials were wrong; asking a
      // third time would only be a loop.
      attempts += 1;
      if (!token || attempts > 1) return { cancel: true };
      return { username: record.username ?? 'git', password: token };
    };

    return { url: record.url, http: createRemoteHttp(this.remoteHttp!), onAuth };
  }

  /** Talks to a remote, and turns what went wrong into something a person can act on. */
  private async talkToRemote<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AppError) throw error;
      const code = (error as { code?: string }).code;
      const status = (error as { data?: { statusCode?: number } }).data?.statusCode;

      if (error instanceof RemoteRefusedError || (error as Error).name === 'RemoteRefusedError') {
        throw new AppError('PRECONDITION_FAILED', (error as Error).message, { expose: true });
      }
      if (code === 'PushRejectedError') {
        throw new AppError(
          'CONFLICT',
          'The remote has commits this branch does not. Pull first, then push.',
          { expose: true },
        );
      }
      if (code === 'UserCanceledError' || status === 401 || status === 403) {
        throw new AppError(
          'PRECONDITION_FAILED',
          'The remote refused these credentials. Check the username and token.',
          { expose: true },
        );
      }
      if (code === 'NotFoundError' || status === 404) {
        throw new AppError(
          'PRECONDITION_FAILED',
          (error as Error).message.startsWith('The remote')
            ? (error as Error).message
            : 'There is no repository at that address, or these credentials cannot see it.',
          { expose: true },
        );
      }
      this.log.warn({ err: error }, 'a git remote could not be reached');
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'The remote could not be reached. It may be down, or the address may be wrong.',
        { expose: true },
      );
    }
  }

  /** The project's files, in the shape git wants them. */
  private async projectFiles(projectId: string): Promise<GitFile[]> {
    const entries = await this.files.exportAll(projectId);
    return entries.map((entry) => ({ path: entry.path, content: entry.content }));
  }

  /** The stored repository, checked against what was recorded. */
  private async fetchArchive(record: RepositoryRecord): Promise<Buffer> {
    const stream = await this.storage.get(record.storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    const archive = Buffer.concat(chunks);

    const checksum = createHash('sha256').update(archive).digest('hex');
    if (checksum !== record.checksum) {
      this.log.error(
        { projectId: record.projectId, expected: record.checksum, actual: checksum },
        'a repository archive does not match its recorded checksum',
      );
      throw new AppError(
        'STORAGE_FAILED',
        'This project history is damaged: what came back is not what was stored.',
        { expose: true },
      );
    }

    return archive;
  }

  private requireValidMessage(input: string): string {
    const result = commitMessageSchema.safeParse(input);
    if (!result.success) {
      throw new AppError('VALIDATION_FAILED', 'That message cannot be used', {
        details: {
          fields: [
            { path: 'message', message: result.error.issues[0]?.message ?? 'Invalid message' },
          ],
        },
      });
    }
    return result.data;
  }
}
