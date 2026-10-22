import type { Logger } from 'pino';
import type { DatabaseBackupSummary } from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import type { ExecutionProvider } from '../../execution/provider.js';
import type { ProjectEventPublisher } from '../../events/project-event-bus.js';
import type { StorageProvider } from '../../storage/provider.js';
import type { BackupRecord, BackupRepository } from './backup.repository.js';

export interface BackupServiceOptions {
  image: string;
  timeoutMs: number;
  maxPerProject: number;
  listLimit: number;
  limits: { cpuMillicores: number; memoryMb: number; pidsLimit: number };
}

const DUMP_PATH = 'dump.pgcustom';

export class BackupService {
  constructor(
    private readonly backups: BackupRepository,
    private readonly execution: ExecutionProvider,
    private readonly storage: StorageProvider,
    private readonly options: BackupServiceOptions,
    private readonly log: Logger,
  ) {}

  private events?: ProjectEventPublisher;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }

  async list(projectId: string): Promise<DatabaseBackupSummary[]> {
    const records = await this.backups.listForProject(projectId, this.options.listLimit);
    return records.map(toSummary);
  }

  async create(
    projectId: string,
    database: { databaseId: string; connectionUrl: string },
    userId: string,
    input: { note?: string | undefined },
  ): Promise<DatabaseBackupSummary> {
    const reason = await this.storage.unavailableReason();
    if (reason) throw new AppError('SERVICE_UNAVAILABLE', reason, { expose: true });

    const executionReason = await this.execution.unavailableReason();
    if (executionReason) {
      throw new AppError('SERVICE_UNAVAILABLE', executionReason, { expose: true });
    }

    await this.prune(projectId);

    const record = await this.backups.create({
      databaseId: database.databaseId,
      projectId,
      note: input.note?.trim() ? input.note.trim() : null,
      createdById: userId,
    });

    this.events?.publish(projectId, { type: 'config.changed', scope: 'database' });

    try {
      const dump = await this.runDump(projectId, record.id, database.connectionUrl);

      const storageKey = `database-backups/${projectId}/${record.id}.pgcustom`;
      await this.storage.put(storageKey, dump, 'application/octet-stream');

      await this.backups.markReady(record.id, { storageKey, sizeBytes: dump.byteLength });

      this.log.info(
        { projectId, backupId: record.id, bytes: dump.byteLength },
        'a database backup was taken',
      );
    } catch (error) {
      const message =
        error instanceof AppError && error.expose
          ? error.message
          : 'The database could not be copied.';

      await this.backups.markFailed(record.id, message).catch(() => undefined);
      this.log.error({ err: error, projectId, backupId: record.id }, 'a database backup failed');
      this.events?.publish(projectId, { type: 'config.changed', scope: 'database' });
      throw error;
    }

    this.events?.publish(projectId, { type: 'config.changed', scope: 'database' });

    const updated = await this.backups.findById(projectId, record.id);
    return toSummary(updated ?? record);
  }

  async restore(projectId: string, backupId: string, connectionUrl: string): Promise<void> {
    const record = await this.backups.findById(projectId, backupId);
    if (!record) throw new AppError('NOT_FOUND', 'There is no backup with that identifier');

    if (record.status !== 'READY' || !record.storageKey) {
      throw new AppError(
        'PRECONDITION_FAILED',
        'That backup never finished, so there is nothing to put back.',
        { expose: true },
      );
    }

    const reason = await this.execution.unavailableReason();
    if (reason) throw new AppError('SERVICE_UNAVAILABLE', reason, { expose: true });

    const stream = await this.storage.get(record.storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));

    await this.runRestore(projectId, record.id, connectionUrl, Buffer.concat(chunks));

    this.log.info({ projectId, backupId }, 'a database was restored from a backup');
    this.events?.publish(projectId, { type: 'config.changed', scope: 'database' });
  }

  async remove(projectId: string, backupId: string): Promise<void> {
    const record = await this.backups.findById(projectId, backupId);
    if (!record) throw new AppError('NOT_FOUND', 'There is no backup with that identifier');

    await this.release(record);
    await this.backups.deleteById(record.id);

    this.events?.publish(projectId, { type: 'config.changed', scope: 'database' });
  }

  async releaseProject(projectId: string): Promise<void> {
    for (const key of await this.backups.storageKeysForProject(projectId)) {
      await this.storage.delete(key).catch((error: unknown) => {
        this.log.error(
          { err: error, projectId, storageKey: key },
          'a backup object was left behind',
        );
      });
    }
  }

  private async runDump(projectId: string, backupId: string, url: string): Promise<Buffer> {
    const handle = await this.execution.create({
      workloadId: backupId,
      kind: 'deployment',
      projectId,
      image: this.options.image,
      limits: this.options.limits,
      env: { PLATFORM_DATABASE_URL: url },
    });

    try {
      await this.execution.start(handle);

      await this.run(
        handle,
        `pg_dump --no-owner --no-privileges --format=custom --file='${DUMP_PATH}' "$PLATFORM_DATABASE_URL"`,
        'The database could not be copied.',
      );

      const files = await this.execution.readDirectory(handle, '.');
      const dump = files.find((file) => file.path === DUMP_PATH);

      if (!dump?.content) {
        throw new AppError('EXECUTION_FAILED', 'The copy produced no file.', { expose: true });
      }

      return Buffer.from(dump.content);
    } finally {
      await this.execution.destroy(handle).catch((error: unknown) => {
        this.log.error({ err: error, backupId }, 'a backup workload could not be removed');
      });
    }
  }

  private async runRestore(
    projectId: string,
    backupId: string,
    url: string,
    dump: Buffer,
  ): Promise<void> {
    const handle = await this.execution.create({
      workloadId: `restore-${backupId}`,
      kind: 'deployment',
      projectId,
      image: this.options.image,
      limits: this.options.limits,
      env: { PLATFORM_DATABASE_URL: url },
    });

    try {
      await this.execution.seedWorkspace(handle, [{ path: DUMP_PATH, content: dump }]);
      await this.execution.start(handle);

      await this.run(
        handle,
        `pg_restore --no-owner --no-privileges --clean --if-exists --dbname="$PLATFORM_DATABASE_URL" '${DUMP_PATH}'`,
        'The database could not be restored.',
      );
    } finally {
      await this.execution.destroy(handle).catch((error: unknown) => {
        this.log.error({ err: error, backupId }, 'a restore workload could not be removed');
      });
    }
  }

  private async run(
    handle: { externalId: string },
    command: string,
    failure: string,
  ): Promise<void> {
    const output: string[] = [];

    const process = await this.execution.startProcess(handle, { command });

    process.onOutput(({ chunk }) => {
      if (output.length < 200) output.push(Buffer.from(chunk).toString('utf8'));
    });

    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), this.options.timeoutMs);
      timer.unref();

      process.onExit((exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });

    if (code !== 0) {
      throw new AppError('EXECUTION_FAILED', failure, {
        expose: true,
        context: { output: output.join('').slice(-2_000), code },
      });
    }
  }

  private async prune(projectId: string): Promise<void> {
    const held = await this.backups.countForProject(projectId);
    const excess = held - (this.options.maxPerProject - 1);
    if (excess <= 0) return;

    for (const record of await this.backups.listPrunable(projectId, excess)) {
      await this.release(record);
      await this.backups.deleteById(record.id);
    }
  }

  private async release(record: BackupRecord): Promise<void> {
    if (!record.storageKey) return;

    await this.storage.delete(record.storageKey).catch((error: unknown) => {
      this.log.error(
        { err: error, backupId: record.id, storageKey: record.storageKey },
        'a backup object was left behind',
      );
    });
  }
}

function toSummary(record: BackupRecord): DatabaseBackupSummary {
  return {
    id: record.id,
    status: record.status,
    note: record.note,
    sizeBytes: record.sizeBytes,
    message: record.message,
    createdBy: record.createdBy?.username ?? null,
    createdAt: record.createdAt.toISOString(),
    completedAt: record.completedAt?.toISOString() ?? null,
  };
}
