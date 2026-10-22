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

export interface SnapshotServiceOptions {
  maxPerProject: number;
  maxAutomaticPerProject: number;
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

  private events: ProjectEventPublisher | undefined;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }

  unavailableReason(): Promise<string | null> {
    return this.storage.unavailableReason();
  }

  async list(projectId: string): Promise<SnapshotSummary[]> {
    const records = await this.snapshots.listForProject(projectId);
    return records.map(toSummary);
  }

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

  async captureBeforeRestore(
    projectId: string,
    userId: string,
    describing: string,
    options: { keep?: string } = {},
  ): Promise<SnapshotSummary> {
    await this.pruneAutomatic(projectId, this.options.maxAutomaticPerProject - 1, options.keep);

    const summary = await this.capture(projectId, userId, {
      name: this.truncateName(`Before restoring ${describing}`),
      description: 'Taken automatically so this restore could be undone.',
      kind: 'AUTOMATIC',
    });

    this.events?.publish(projectId, { type: 'snapshots.changed' });
    return summary;
  }

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

  private async capture(
    projectId: string,
    userId: string,
    input: { name: string; description: string | null; kind: SnapshotKind },
  ): Promise<SnapshotSummary> {
    const reason = await this.storage.unavailableReason();
    if (reason) {
      throw new AppError('SERVICE_UNAVAILABLE', reason, { expose: true });
    }

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
      await this.storage.delete(storageKey).catch((cleanup: unknown) => {
        this.log.error(
          { err: cleanup, storageKey },
          'an orphaned snapshot archive could not be removed',
        );
      });
      throw error;
    }
  }

  private async pruneAutomatic(projectId: string, keep: number, spare?: string): Promise<void> {
    const removed = new Set<string>();

    for (;;) {
      const held = await this.snapshots.countForProject(projectId, 'AUTOMATIC');
      if (held <= Math.max(keep, 0)) return;

      const oldest = await this.snapshots.oldestOfKind(projectId, 'AUTOMATIC', spare);
      if (!oldest || removed.has(oldest.id)) return;

      await this.remove(projectId, oldest.id);
      removed.add(oldest.id);
    }
  }

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
