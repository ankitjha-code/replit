import { createHash, randomUUID } from 'node:crypto';
import {
  MAX_SNAPSHOT_NAME_LENGTH,
  snapshotDescriptionSchema,
  snapshotNameSchema,
  type SnapshotKind,
  type SnapshotSummary,
} from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { ProjectEventPublisher } from '../../events/project-event-bus.js';
import type { StorageProvider } from '../../storage/provider.js';
import type { FileService, ProjectFileExport } from '../files/file.service.js';
import { buildSnapshotArchive, readSnapshotArchive } from './snapshot-archive.js';
import type { SnapshotRecord, SnapshotRepository } from './snapshot.repository.js';

/**
 * Project snapshots.
 *
 * A snapshot is a named, frozen copy of every source file in a project. Editing
 * is continuous and autosaving, so there is no moment at which a project is "as
 * it was this morning" unless somebody wrote one down. This is how they write
 * one down.
 *
 * The rule that shapes the order of everything here is the same one the asset
 * service follows: a row saying an archive exists when the bytes do not is a
 * promise the platform cannot keep. So the archive is written first and the row
 * second, and a failure to record removes what was just written.
 */

export interface SnapshotServiceOptions {
  /** How many a person may keep. Automatic ones are not counted against it. */
  maxPerProject: number;
  /**
   * How many of the platform's own are kept before the oldest is pruned.
   *
   * Small on purpose. These exist so that the last restore can be undone, and
   * an undo of an undo of an undo is not a feature anybody has asked for.
   */
  maxAutomaticPerProject: number;
  /** The largest archive a single snapshot may produce. */
  maxArchiveBytes: number;
}

export class SnapshotService {
  constructor(
    private readonly snapshots: SnapshotRepository,
    private readonly files: FileService,
    private readonly storage: StorageProvider,
    private readonly options: SnapshotServiceOptions,
    private readonly log: Logger,
  ) {}

  get limit(): number {
    return this.options.maxPerProject;
  }

  /**
   * Where snapshot changes are announced, when there is anywhere to announce
   * them. Set after construction, as the file service's is.
   */
  private events: ProjectEventPublisher | undefined;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }

  /**
   * Why a snapshot cannot be taken here, or null when one can.
   *
   * Taking one needs somewhere to put it. An installation with no object store
   * says so rather than offering a button that records a row describing an
   * archive nobody ever wrote.
   */
  unavailableReason(): Promise<string | null> {
    return this.storage.unavailableReason();
  }

  async list(projectId: string): Promise<SnapshotSummary[]> {
    const records = await this.snapshots.listForProject(projectId);
    return records.map(toSummary);
  }

  /**
   * Takes one at somebody's request.
   *
   * Counted against what a person may keep. The platform's own snapshots, taken
   * before a restore, are counted separately: see `captureBeforeRestore`.
   */
  async create(
    projectId: string,
    userId: string,
    input: { name: string; description?: string | undefined },
  ): Promise<SnapshotSummary> {
    const name = this.requireValidName(input.name);
    const description = this.requireValidDescription(input.description);

    const held = await this.snapshots.countForProject(projectId, 'MANUAL');
    if (held >= this.options.maxPerProject) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        `This project already has its limit of ${this.options.maxPerProject} snapshots. Remove one first.`,
      );
    }

    const summary = await this.capture(projectId, userId, {
      name,
      description,
      kind: 'MANUAL',
    });

    this.events?.publish(projectId, { type: 'snapshots.changed' });
    return summary;
  }

  /**
   * Takes the one that makes a restore survivable.
   *
   * A restore replaces every file in a project, so without this the price of
   * going back an hour is losing the last hour irrecoverably. Taken by the
   * platform, named by the platform, and not counted against the allowance a
   * person has: refusing to let somebody go back because they had used up their
   * snapshots would be the worst possible moment to enforce a quota.
   *
   * The oldest is pruned when there are too many, rather than the newest
   * refused, because the useful one is always the most recent.
   */
  async captureBeforeRestore(
    projectId: string,
    userId: string,
    describing: string,
    /**
     * A snapshot pruning must not touch.
     *
     * Undoing a restore means restoring from an automatic snapshot, and those
     * are precisely the ones pruning removes. Without this, going back twice
     * could delete the thing being gone back to.
     */
    options: { keep?: string } = {},
  ): Promise<SnapshotSummary> {
    await this.pruneAutomatic(projectId, this.options.maxAutomaticPerProject - 1, options.keep);

    const summary = await this.capture(projectId, userId, {
      // Named for what it protects against, not for what it contains: this is
      // found by somebody looking for the state they were in before they
      // pressed a button they regret.
      name: this.truncateName(`Before restoring ${describing}`),
      description: 'Taken automatically so this restore could be undone.',
      kind: 'AUTOMATIC',
    });

    this.events?.publish(projectId, { type: 'snapshots.changed' });
    return summary;
  }

  /**
   * Takes the fixed version a deployment is built from.
   *
   * Never pruned and never counted against what a person may keep, because it
   * is not a convenience: it is the answer to "what is actually running", and
   * losing it would mean a deployment nobody can describe or rebuild. It is
   * removed when the deployment that points at it is.
   */
  async captureForDeployment(
    projectId: string,
    userId: string,
    describing: string,
  ): Promise<SnapshotSummary> {
    const summary = await this.capture(projectId, userId, {
      name: this.truncateName(`Deployed: ${describing}`),
      description: 'The version of this project a deployment was built from.',
      kind: 'DEPLOYMENT',
    });

    this.events?.publish(projectId, { type: 'snapshots.changed' });
    return summary;
  }

  /**
   * The files a snapshot holds, ready to be written back into a project.
   *
   * Reads the archive, which verifies its checksum, and unpacks it. Every path
   * is checked on the way out as well as on the way in: the archive may be old,
   * and may have been somewhere else in between.
   */
  async readEntries(
    projectId: string,
    snapshotId: string,
  ): Promise<{
    record: SnapshotRecord;
    entries: ProjectFileExport[];
  }> {
    const { record, archive } = await this.read(projectId, snapshotId);
    const entries = await readSnapshotArchive(archive);
    return { record, entries };
  }

  /**
   * The part of taking a snapshot that does not depend on who asked.
   *
   * The order is the one the asset service set and every store-then-record path
   * in the codebase follows: bytes first, row second, and a failure to record
   * removes the bytes. A row describing an archive that does not exist is a
   * promise the platform cannot keep.
   */
  private async capture(
    projectId: string,
    userId: string,
    input: { name: string; description: string | null; kind: SnapshotKind },
  ): Promise<SnapshotSummary> {
    const reason = await this.storage.unavailableReason();
    if (reason) {
      throw new AppError('SERVICE_UNAVAILABLE', reason, { expose: true });
    }

    /*
     * The files as they are at this instant.
     *
     * Nothing locks them, so an edit landing during this read is either wholly
     * in or wholly out of the snapshot, depending on when it committed. That is
     * the honest guarantee: a snapshot is a moment, not a transaction across
     * one, and pretending otherwise would need a lock on the whole project for
     * as long as an upload takes.
     */
    const entries = await this.files.exportAll(projectId);
    const { archive, fileCount } = await buildSnapshotArchive(entries);

    if (archive.byteLength > this.options.maxArchiveBytes) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        'This project is too large to snapshot on this installation.',
      );
    }

    const storageKey = `snapshots/${projectId}/${randomUUID()}.tar`;
    const checksum = createHash('sha256').update(archive).digest('hex');

    await this.storage.put(storageKey, archive, 'application/x-tar');

    try {
      const record = await this.snapshots.create({
        projectId,
        name: input.name,
        description: input.description,
        kind: input.kind,
        storageKey,
        fileCount,
        sizeBytes: archive.byteLength,
        checksum,
        createdById: userId,
      });

      this.log.info(
        { projectId, snapshotId: record.id, fileCount, kind: input.kind },
        'snapshot taken',
      );
      return toSummary(record);
    } catch (error) {
      // The bytes are already there and nothing now points at them. Removing
      // them is the difference between a failed snapshot and a leak.
      await this.storage.delete(storageKey).catch((cleanup: unknown) => {
        this.log.error(
          { err: cleanup, storageKey },
          'an orphaned snapshot archive could not be removed',
        );
      });
      throw error;
    }
  }

  /**
   * Removes the platform's own oldest snapshots until only `keep` remain.
   *
   * `spare` names one that must survive regardless. Removing more than it has
   * to is the failure mode to avoid here: these are the snapshots somebody
   * reaches for when a restore went the wrong way.
   */
  private async pruneAutomatic(projectId: string, keep: number, spare?: string): Promise<void> {
    const removed = new Set<string>();

    for (;;) {
      const held = await this.snapshots.countForProject(projectId, 'AUTOMATIC');
      if (held <= Math.max(keep, 0)) return;

      const oldest = await this.snapshots.oldestOfKind(projectId, 'AUTOMATIC', spare);
      /*
       * Nothing left that may be removed.
       *
       * Either the count and the table disagree, or everything remaining is the
       * one snapshot being spared. Both mean stopping: one more pass would
       * either loop forever or delete what was explicitly kept.
       */
      if (!oldest || removed.has(oldest.id)) return;

      await this.remove(projectId, oldest.id);
      removed.add(oldest.id);
    }
  }

  /**
   * Discards one.
   *
   * The row goes first here, which is the opposite of how one is created and
   * for the same reason: whichever half is left behind should be the one that
   * costs nothing. A row with no archive is a snapshot that cannot be restored;
   * an archive with no row is bytes nobody is charged for and nobody can see.
   */
  async remove(projectId: string, snapshotId: string): Promise<void> {
    const record = await this.snapshots.findById(projectId, snapshotId);
    if (!record) throw new AppError('NOT_FOUND', 'There is no snapshot with that identifier');

    await this.snapshots.deleteById(projectId, snapshotId);

    await this.storage.delete(record.storageKey).catch((error: unknown) => {
      this.log.error(
        { err: error, projectId, storageKey: record.storageKey },
        'a snapshot archive could not be removed and is now orphaned',
      );
    });

    this.log.info({ projectId, snapshotId }, 'snapshot removed');
    this.events?.publish(projectId, { type: 'snapshots.changed' });
  }

  /**
   * The archive itself, checked against what was recorded.
   *
   * Every use of an archive goes through here, downloads and restores alike,
   * so the checksum is verified on every path out of storage. An archive that
   * fails the check is refused rather than handed back: a project restored from
   * half a file is worse than a snapshot that admits it is gone.
   */
  async read(
    projectId: string,
    snapshotId: string,
  ): Promise<{ record: SnapshotRecord; archive: Buffer }> {
    const record = await this.snapshots.findById(projectId, snapshotId);
    if (!record) throw new AppError('NOT_FOUND', 'There is no snapshot with that identifier');

    const stream = await this.storage.get(record.storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    const archive = Buffer.concat(chunks);

    const checksum = createHash('sha256').update(archive).digest('hex');
    if (checksum !== record.checksum) {
      this.log.error(
        { projectId, snapshotId, expected: record.checksum, actual: checksum },
        'a snapshot archive does not match its recorded checksum',
      );
      throw new AppError(
        'STORAGE_FAILED',
        'This snapshot is damaged: what came back is not what was stored.',
        { expose: true },
      );
    }

    return { record, archive };
  }

  /**
   * Removes every snapshot a project has, for when the project is going.
   *
   * Deliberately does not throw. A project must stay deletable when the object
   * store is unreachable, so a failure is logged as a leak rather than turned
   * into a project nobody can remove.
   */
  async releaseProject(projectId: string): Promise<void> {
    const keys = await this.snapshots.storageKeysForProject(projectId);

    for (const key of keys) {
      await this.storage.delete(key).catch((error: unknown) => {
        this.log.error(
          { err: error, projectId, storageKey: key },
          'a snapshot archive could not be removed and is now orphaned',
        );
      });
    }

    await this.snapshots.deleteForProject(projectId);
  }

  /**
   * Shortens a generated name to what the column holds.
   *
   * Only ever used on names the platform writes itself. A name somebody typed
   * is refused when it is too long rather than silently trimmed, because
   * quietly storing something other than what they wrote is worse.
   */
  private truncateName(input: string): string {
    return input.length <= MAX_SNAPSHOT_NAME_LENGTH
      ? input
      : `${input.slice(0, MAX_SNAPSHOT_NAME_LENGTH - 1)}\u2026`;
  }

  private requireValidName(input: string): string {
    const result = snapshotNameSchema.safeParse(input);
    if (!result.success) {
      throw new AppError('VALIDATION_FAILED', 'That name cannot be used', {
        details: {
          fields: [{ path: 'name', message: result.error.issues[0]?.message ?? 'Invalid name' }],
        },
      });
    }
    return result.data;
  }

  private requireValidDescription(input: string | undefined): string | null {
    if (input === undefined) return null;

    const result = snapshotDescriptionSchema.safeParse(input);
    if (!result.success) {
      throw new AppError('VALIDATION_FAILED', 'That description cannot be used', {
        details: {
          fields: [
            {
              path: 'description',
              message: result.error.issues[0]?.message ?? 'Invalid description',
            },
          ],
        },
      });
    }
    return result.data.length === 0 ? null : result.data;
  }
}

function toSummary(record: SnapshotRecord): SnapshotSummary {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    kind: record.kind,
    fileCount: record.fileCount,
    sizeBytes: record.sizeBytes,
    checksum: record.checksum,
    createdAt: record.createdAt.toISOString(),
    createdBy: record.createdBy?.username ?? null,
  };
}
