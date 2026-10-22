import type { Database } from '../../db/client.js';

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

  listForProject(projectId: string, limit: number): Promise<BackupRecord[]> {
    return this.db.projectDatabaseBackup.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: FIELDS,
    });
  }

  findById(projectId: string, id: string): Promise<BackupRecord | null> {
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

  async storageKeysForProject(projectId: string): Promise<string[]> {
    const rows = await this.db.projectDatabaseBackup.findMany({
      where: { projectId, storageKey: { not: null } },
      select: { storageKey: true },
    });

    return rows.map((row) => row.storageKey).filter((key): key is string => key !== null);
  }
}
