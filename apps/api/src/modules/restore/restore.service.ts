import type { GitStateResponse, MergeResult, RestoreResult } from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { FileService } from '../files/file.service.js';
import type { GitAuthor } from '../git/git-engine.js';
import type { GitPlan, GitService } from '../git/git.service.js';
import type { RuntimeService } from '../runtimes/runtime.service.js';
import type { SnapshotService } from '../snapshots/snapshot.service.js';

export class RestoreService {
  constructor(
    private readonly files: FileService,
    private readonly snapshots: SnapshotService,
    private readonly git: GitService,
    private readonly runtimes: RuntimeService,
    private readonly log: Logger,
  ) {}

  async fromSnapshot(
    projectId: string,
    userId: string,
    snapshotId: string,
  ): Promise<RestoreResult> {
    await this.requireStopped(projectId);

    const { record, entries } = await this.snapshots.readEntries(projectId, snapshotId);

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

  async switchBranch(projectId: string, name: string): Promise<GitStateResponse> {
    await this.requireStopped(projectId);
    await this.carryOut(projectId, await this.git.planSwitch(projectId, name));
    return this.git.describe(projectId);
  }

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

  async pull(
    projectId: string,
    author: GitAuthor,
  ): Promise<{ outcome: GitPlan['outcome']; state: GitStateResponse }> {
    await this.requireStopped(projectId);
    const plan = await this.git.planPull(projectId, author);
    await this.carryOut(projectId, plan);
    return { outcome: plan.outcome, state: await this.git.describe(projectId) };
  }

  private async carryOut(projectId: string, plan: GitPlan): Promise<void> {
    if (plan.entries) {
      const counts = await this.files.replaceAll(projectId, plan.entries, 'restore');
      this.log.info({ projectId, outcome: plan.outcome, ...counts }, 'files follow git');
    }
    await plan.apply();
  }

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
    const isText = Buffer.from(text, 'utf8').equals(bytes);

    await this.files.write(projectId, {
      path: wanted,
      content: isText ? text : bytes.toString('base64'),
      encoding: isText ? 'utf8' : 'base64',
    });

    this.log.info({ projectId, path: wanted, source: source.kind }, 'one file restored');
    return { path: wanted, previous };
  }

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

function firstLine(message: string): string {
  const line = message.split('\n')[0]?.trim() ?? '';
  return line.length > 0 ? line : '(no message)';
}
