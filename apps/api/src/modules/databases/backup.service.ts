import type { Logger } from 'pino';
import type { DatabaseBackupSummary } from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import type { ExecutionProvider } from '../../execution/provider.js';
import type { ProjectEventPublisher } from '../../events/project-event-bus.js';
import type { StorageProvider } from '../../storage/provider.js';
import type { BackupRecord, BackupRepository } from './backup.repository.js';

/**
 * Copies of a project's database, taken and put back.
 *
 * ## Why this runs in a container
 *
 * The right tool for a PostgreSQL dump is `pg_dump`, and the platform is not
 * allowed to run it: nothing here may execute a command on its host, and that
 * rule has no exceptions for tools the platform trusts — the moment there is
 * one, the boundary is a matter of judgement rather than a property.
 *
 * Writing a dump in SQL instead was the alternative, and it is worse than it
 * sounds. A correct logical dump has to reproduce types, sequences, defaults,
 * constraints, indexes and extensions in an order that restores; getting that
 * subtly wrong produces a backup that looks fine and restores incompletely,
 * which is the worst possible failure for a backup.
 *
 * So `pg_dump` runs where every other untrusted or heavyweight thing runs: in a
 * container, on the project's own network, torn down afterwards. That is the
 * same machinery a deployment build uses, which is also why it took no new
 * infrastructure to add.
 *
 * ## The dump format
 *
 * The custom format (`-Fc`), which is compressed and which `pg_restore` can
 * read selectively. Plain SQL would be readable, and readable is not what a
 * backup is for — it is for going back, and going back from plain SQL means
 * `psql` and no way to skip a broken object.
 *
 * `--no-owner` and `--no-privileges`, because the role that owns objects in one
 * database is generated from the project identifier and a restore may land in a
 * database owned by a different generated role. Keeping ownership would make
 * every restore fail on a name nobody chose.
 */

export interface BackupServiceOptions {
  /** The image `pg_dump` and `pg_restore` come from. */
  image: string;
  /** How long a dump or a restore may run before it is abandoned. */
  timeoutMs: number;
  /** Backups one project may keep before the oldest are removed. */
  maxPerProject: number;
  listLimit: number;
  /** What the dump workload is allowed of the machine. */
  limits: { cpuMillicores: number; memoryMb: number; pidsLimit: number };
}

/** Where the dump is written inside the workload, and read back from. */
const DUMP_PATH = 'dump.pgcustom';

export class BackupService {
  constructor(
    private readonly backups: BackupRepository,
    private readonly execution: ExecutionProvider,
    private readonly storage: StorageProvider,
    private readonly options: BackupServiceOptions,
    private readonly log: Logger,
  ) {}

  /** Where changes are announced, when there is anywhere to announce them. */
  private events?: ProjectEventPublisher;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }

  async list(projectId: string): Promise<DatabaseBackupSummary[]> {
    const records = await this.backups.listForProject(projectId, this.options.listLimit);
    return records.map(toSummary);
  }

  /**
   * Takes a copy of the database as it is now.
   *
   * The row is written first and left RUNNING, so a dump that dies with the
   * process it was running in is visible as a backup that never finished rather
   * than as nothing at all. That is the same reasoning the deployment row
   * follows, and it is what makes the failure legible instead of silent.
   */
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

  /**
   * Puts a backup back.
   *
   * **This destroys whatever is in the database now**, which is what restoring
   * means and is why the route asks for confirmation rather than treating it as
   * an ordinary action. `--clean --if-exists` drops each object before
   * recreating it, so a restore into a database that already has data is a
   * replacement rather than a merge — a merge would be neither the old data nor
   * the new one.
   *
   * No backup is taken first. Snapshots do that before a restore because a
   * project's files are small and the platform has somewhere to put them; a
   * database copy is arbitrarily large and taking one automatically would turn
   * every restore into two long container runs and could fill an installation's
   * object storage without anybody asking for it. The interface says plainly
   * what will be lost instead.
   */
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

  /** Everything this project's backups hold, for deleting the project. */
  async releaseProject(projectId: string): Promise<void> {
    for (const key of await this.backups.storageKeysForProject(projectId)) {
      await this.storage.delete(key).catch((error: unknown) => {
        // Logged rather than fatal, exactly like a snapshot's: a project must
        // stay deletable when object storage is unreachable, and the cleanup
        // sweep finds the object later.
        this.log.error(
          { err: error, projectId, storageKey: key },
          'a backup object was left behind',
        );
      });
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Runs `pg_dump` in a container and brings the file back.
   *
   * The workload is given the project's own database URL, which is the one
   * thing in this file that looks like it breaks the rule about never handing
   * platform credentials to a workload. It does not: this is the project's own
   * credential for the project's own data, the same one its runtime already
   * gets, and the container runs a command the platform wrote rather than
   * anything a person supplied.
   */
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
      // Always, including on failure. A dump container holds a copy of somebody's
      // data and has no further use the moment this returns.
      await this.execution.destroy(handle).catch((error: unknown) => {
        this.log.error({ err: error, backupId }, 'a backup workload could not be removed');
      });
    }
  }

  /** Runs `pg_restore` in a container, with the dump seeded in as a file. */
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

      /*
       * `--exit-on-error` is deliberately absent.
       *
       * A custom-format restore reports errors for objects it cannot recreate —
       * an extension the target server lacks, a role that does not exist — and
       * stopping on the first would abandon a restore that was about to put
       * every table back. What matters is that the data lands; what could not be
       * recreated is in the output.
       */
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

  /** One command, with a deadline and its output kept for the failure message. */
  private async run(
    handle: { externalId: string },
    command: string,
    failure: string,
  ): Promise<void> {
    const output: string[] = [];

    const process = await this.execution.startProcess(handle, { command });

    process.onOutput(({ chunk }) => {
      // Bounded: this ends up in a message column, and pg_restore can be chatty.
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

  /** Makes room before recording another one. */
  private async prune(projectId: string): Promise<void> {
    const held = await this.backups.countForProject(projectId);
    const excess = held - (this.options.maxPerProject - 1);
    if (excess <= 0) return;

    for (const record of await this.backups.listPrunable(projectId, excess)) {
      await this.release(record);
      await this.backups.deleteById(record.id);
    }
  }

  /** Lets go of the object a backup holds, without ever failing the caller. */
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
