import type { Database } from '../../db/client.js';

/**
 * The only code that reads or writes the database-backup table.
 *
 * The row is bookkeeping for an object in storage. Nothing here knows how a
 * dump is taken or what is in one.
 */

export type BackupStatus = 'RUNNING' | 'READY' | 'FAILED';

export interface BackupRecord {
  id: string;
  databaseId: string;
  projectId: string;
  status: BackupStatus;
  note: string | null;
  storageKey: string | null;
  sizeBytes: number | null;
  message: string | null;
  createdById: string | null;
  createdBy: { username: string } | null;
  createdAt: Date;
  completedAt: Date | null;
}

const FIELDS = {
  id: true,
  databaseId: true,
  projectId: true,
  status: true,
  note: true,
  storageKey: true,
  sizeBytes: true,
  message: true,
  createdById: true,
  createdBy: { select: { username: true } },
  createdAt: true,
  completedAt: true,
} as const;

export class BackupRepository {
  constructor(private readonly db: Database) {}

  /** Newest first, which is the order somebody reads a backup list in. */
  listForProject(projectId: string, limit: number): Promise<BackupRecord[]> {
    return this.db.projectDatabaseBackup.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: FIELDS,
    });
  }

  findById(projectId: string, id: string): Promise<BackupRecord | null> {
    // Scoped to the project as well as the id, so an identifier from one
    // project can never address another's.
    return this.db.projectDatabaseBackup.findFirst({ where: { id, projectId }, select: FIELDS });
  }

  create(input: {
    databaseId: string;
    projectId: string;
    note: string | null;
    createdById: string;
  }): Promise<BackupRecord> {
    return this.db.projectDatabaseBackup.create({ data: input, select: FIELDS });
  }

  markReady(id: string, input: { storageKey: string; sizeBytes: number }): Promise<unknown> {
    return this.db.projectDatabaseBackup.update({
      where: { id },
      data: { ...input, status: 'READY', message: null, completedAt: new Date() },
    });
  }

  markFailed(id: string, message: string): Promise<unknown> {
    return this.db.projectDatabaseBackup.update({
      where: { id },
      data: { status: 'FAILED', message, completedAt: new Date() },
    });
  }

  countForProject(projectId: string): Promise<number> {
    return this.db.projectDatabaseBackup.count({ where: { projectId } });
  }

  /**
   * The oldest backups, for making room.
   *
   * Only ones that finished one way or the other. A dump still running is never
   * a candidate however old it looks: it is holding a container.
   */
  listPrunable(projectId: string, take: number): Promise<BackupRecord[]> {
    return this.db.projectDatabaseBackup.findMany({
      where: { projectId, status: { in: ['READY', 'FAILED'] } },
      orderBy: { createdAt: 'asc' },
      take,
      select: FIELDS,
    });
  }

  async deleteById(id: string): Promise<void> {
    await this.db.projectDatabaseBackup.deleteMany({ where: { id } });
  }

  /** Every stored dump belonging to a project, for deleting the project. */
  async storageKeysForProject(projectId: string): Promise<string[]> {
    const rows = await this.db.projectDatabaseBackup.findMany({
      where: { projectId, storageKey: { not: null } },
      select: { storageKey: true },
    });

    return rows.map((row) => row.storageKey).filter((key): key is string => key !== null);
  }
}
