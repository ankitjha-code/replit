import type { GitStateResponse, MergeResult, RestoreResult } from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { FileService } from '../files/file.service.js';
import type { GitAuthor } from '../git/git-engine.js';
import type { GitPlan, GitService } from '../git/git.service.js';
import type { RuntimeService } from '../runtimes/runtime.service.js';
import type { SnapshotService } from '../snapshots/snapshot.service.js';

/**
 * Putting a project back to how it was.
 *
 * The operation snapshots and history were built for. Until now both could only
 * be read: a snapshot was a download and a commit was something to look at, and
 * the question anybody actually has — "put it back" — had no answer.
 *
 * A restore is destructive, and the whole shape of this service is an argument
 * with that fact:
 *
 *   1. A snapshot of what is there now is taken first, and the restore is
 *      refused if one cannot be. That makes every restore undoable, and it is
 *      the reason this is a service of its own rather than a method on each of
 *      the two things that can be restored from.
 *   2. Nothing is merged. The project becomes exactly what the source held.
 *      Merging would need a common ancestor, and between the files as they are
 *      and the files as they were in March there is no useful one.
 *   3. It is refused while the project is running, because it would not survive.
 *      Stopping a runtime reads its filesystem back into the project, so a
 *      restore into a running project would be quietly undone minutes later by
 *      a container that never heard about it.
 *
 * Lives above both the snapshot and git services because it needs each of them
 * and neither should need the other. A snapshot knows nothing about commits, and
 * a commit knows nothing about snapshots; restoring is the one place the two
 * meet, and it is the only place that is allowed to write files.
 */
export class RestoreService {
  constructor(
    private readonly files: FileService,
    private readonly snapshots: SnapshotService,
    private readonly git: GitService,
    private readonly runtimes: RuntimeService,
    private readonly log: Logger,
  ) {}

  /** Puts the project back to what a snapshot holds. */
  async fromSnapshot(
    projectId: string,
    userId: string,
    snapshotId: string,
  ): Promise<RestoreResult> {
    await this.requireStopped(projectId);

    const { record, entries } = await this.snapshots.readEntries(projectId, snapshotId);

    /*
     * The source is read before the safety snapshot is taken, and named to it.
     *
     * Both halves matter. Reading first means a snapshot whose archive has gone
     * is discovered before anything has been written or pruned. Naming it means
     * the pruning that makes room cannot remove the very snapshot being restored
     * from, which is otherwise reachable: undoing a restore means restoring from
     * an automatic snapshot, and those are exactly the ones pruning takes.
     */
    const safety = await this.snapshots.captureBeforeRestore(projectId, userId, record.name, {
      keep: snapshotId,
    });

    const counts = await this.files.replaceAll(projectId, entries, 'restore');

    this.log.info({ projectId, snapshotId, ...counts }, 'project restored from snapshot');

    return {
      source: 'snapshot',
      reference: record.id,
      label: record.name,
      ...counts,
      safetySnapshot: safety,
      restartRequired: false,
    };
  }

  /**
   * Puts the project back to what a commit contained.
   *
   * Not a checkout: nothing moves the branch, and the next commit's parent is
   * still the current head. What this does is what a person means by "take me
   * back to that": the files become what they were, and the fact that they were
   * changed back is itself recorded as the next commit, which is a truer history
   * than one that pretends the intervening work never happened.
   *
   * Empty directories are the one thing lost relative to a snapshot, because git
   * does not record them.
   */
  async fromCommit(projectId: string, userId: string, oid: string): Promise<RestoreResult> {
    await this.requireStopped(projectId);

    const { commit, entries } = await this.git.readCommitFiles(projectId, oid);

    const subject = firstLine(commit.message);
    const safety = await this.snapshots.captureBeforeRestore(
      projectId,
      userId,
      `commit ${oid.slice(0, 7)}`,
    );

    const counts = await this.files.replaceAll(projectId, entries, 'restore');

    this.log.info({ projectId, oid, ...counts }, 'project restored from commit');

    return {
      source: 'commit',
      reference: commit.oid,
      label: subject,
      ...counts,
      safetySnapshot: safety,
      restartRequired: false,
    };
  }

  /**
   * Makes the project's files another branch.
   *
   * Refused while anything is uncommitted — that check is git's, in the plan —
   * and while the project runs, for the reason every restore is. No safety
   * snapshot: there is nothing uncommitted to lose, and every file the project
   * had is in the branch being left.
   */
  async switchBranch(projectId: string, name: string): Promise<GitStateResponse> {
    await this.requireStopped(projectId);
    await this.carryOut(projectId, await this.git.planSwitch(projectId, name));
    return this.git.describe(projectId);
  }

  /** Brings another branch into the current one, and the project's files with it. */
  async mergeBranch(
    projectId: string,
    branch: string,
    author: GitAuthor,
  ): Promise<{ merge: MergeResult; state: GitStateResponse }> {
    await this.requireStopped(projectId);
    const plan = await this.git.planMerge(projectId, branch, author);
    await this.carryOut(projectId, plan);
    return {
      merge: { outcome: plan.outcome as MergeResult['outcome'], headOid: plan.headOid },
      state: await this.git.describe(projectId),
    };
  }

  /** The remote's copy of the current branch, merged in — or, with no history yet, imported. */
  async pull(
    projectId: string,
    author: GitAuthor,
  ): Promise<{ outcome: GitPlan['outcome']; state: GitStateResponse }> {
    await this.requireStopped(projectId);
    const plan = await this.git.planPull(projectId, author);
    await this.carryOut(projectId, plan);
    return { outcome: plan.outcome, state: await this.git.describe(projectId) };
  }

  /** Files first, then the repository. See `GitPlan` for why in that order. */
  private async carryOut(projectId: string, plan: GitPlan): Promise<void> {
    if (plan.entries) {
      const counts = await this.files.replaceAll(projectId, plan.entries, 'restore');
      this.log.info({ projectId, outcome: plan.outcome, ...counts }, 'files follow git');
    }
    await plan.apply();
  }

  /**
   * Puts one file back to what a snapshot or a commit held.
   *
   * ## Why this does not need the project stopped
   *
   * A whole-project restore does, because a running container's files are read
   * back over the project and would undo it. Writing one file is exactly what
   * saving in the editor does, and that works while the project runs — so this
   * goes through the same write, and is exactly as safe as a save.
   *
   * ## Why no snapshot first
   *
   * One file does not justify copying the whole project. What was there is
   * returned instead, so the page can offer to put it straight back: the same
   * undo, for the size of the change actually made.
   */
  async restoreFile(
    projectId: string,
    source: { kind: 'snapshot'; id: string } | { kind: 'commit'; oid: string },
    path: string,
  ): Promise<{ path: string; previous: { content: string; encoding: 'utf8' | 'base64' } | null }> {
    const entries =
      source.kind === 'snapshot'
        ? (await this.snapshots.readEntries(projectId, source.id)).entries
        : (await this.git.readCommitFiles(projectId, source.oid)).entries;

    const wanted = path.replace(/^\/+/, '');
    const entry = entries.find((candidate) => candidate.path === wanted);

    if (!entry) {
      throw new AppError(
        'NOT_FOUND',
        source.kind === 'snapshot'
          ? 'That file is not in this snapshot.'
          : 'That file is not in this commit.',
        { expose: true },
      );
    }

    if (entry.content === null) {
      throw new AppError(
        'BAD_REQUEST',
        'That is a directory; only a file can be put back on its own.',
        {
          expose: true,
        },
      );
    }

    const previous = await this.files.read(projectId, wanted).then(
      (current) => ({ content: current.content, encoding: current.encoding }),
      () => null,
    );

    const bytes = Buffer.from(entry.content);
    const text = bytes.toString('utf8');
    // Round-tripped to decide the encoding, so binary content is never mangled
    // into replacement characters on its way back in.
    const isText = Buffer.from(text, 'utf8').equals(bytes);

    await this.files.write(projectId, {
      path: wanted,
      content: isText ? text : bytes.toString('base64'),
      encoding: isText ? 'utf8' : 'base64',
    });

    this.log.info({ projectId, path: wanted, source: source.kind }, 'one file restored');
    return { path: wanted, previous };
  }

  /**
   * Refuses while anything is running in this project.
   *
   * Not caution for its own sake. Reading a runtime back into the project is an
   * existing, deliberate behaviour that happens on request and on the way to
   * stopping, and it replaces the project's files with the container's. A
   * restore into a running project would therefore appear to work and then be
   * overwritten by a container holding the version that was just replaced.
   *
   * Refusing is better than restoring and also restarting the container: that
   * would kill whatever is running without being asked, and a restore should not
   * be a way to stop somebody's server.
   */
  private async requireStopped(projectId: string): Promise<void> {
    const state = await this.runtimes.describe(projectId);
    const status = state.runtime?.status;

    if (status === 'RUNNING' || status === 'STARTING') {
      throw new AppError(
        'PRECONDITION_FAILED',
        'Stop this project before restoring. Files are read back out of a running environment, which would overwrite whatever you restore.',
      );
    }
  }
}

/** A commit's subject: the first line, which is what git itself shows. */
function firstLine(message: string): string {
  const line = message.split('\n')[0]?.trim() ?? '';
  return line.length > 0 ? line : '(no message)';
}
