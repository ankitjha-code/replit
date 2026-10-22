import type { SnapshotKind } from '@platform/shared';
import type { Database } from '../../db/client.js';

export interface SnapshotRecord {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  kind: SnapshotKind;
  storageKey: string;
  fileCount: number;
  sizeBytes: number;
  checksum: string;
  createdAt: Date;
  createdBy: { username: string } | null;
}

const FIELDS = {
  id: true,
  projectId: true,
  name: true,
  description: true,
  kind: true,
  storageKey: true,
  fileCount: true,
  sizeBytes: true,
  checksum: true,
  createdAt: true,
  createdBy: { select: { username: true } },
} as const;

export class SnapshotRepository {
  constructor(private readonly db: Database) {}

  listForProject(projectId: string): Promise<SnapshotRecord[]> {
    return this.db.projectSnapshot.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: FIELDS,
    });
  }

  findById(projectId: string, id: string): Promise<SnapshotRecord | null> {
    return this.db.projectSnapshot.findFirst({ where: { id, projectId }, select: FIELDS });
  }

  countForProject(projectId: string, kind: SnapshotKind): Promise<number> {
    return this.db.projectSnapshot.count({ where: { projectId, kind } });
  }

  oldestOfKind(
    projectId: string,
    kind: SnapshotKind,
    exceptId?: string,
  ): Promise<SnapshotRecord | null> {
    return this.db.projectSnapshot.findFirst({
      where: { projectId, kind, ...(exceptId ? { id: { not: exceptId } } : {}) },
      orderBy: { createdAt: 'asc' },
      select: FIELDS,
    });
  }

  async storageKeysForProject(projectId: string): Promise<string[]> {
    const rows = await this.db.projectSnapshot.findMany({
      where: { projectId },
      select: { storageKey: true },
    });
    return rows.map((row) => row.storageKey);
  }

  create(input: {
    projectId: string;
    name: string;
    description: string | null;
    storageKey: string;
    fileCount: number;
    sizeBytes: number;
    checksum: string;
    createdById: string;
    kind: SnapshotKind;
  }): Promise<SnapshotRecord> {
    return this.db.projectSnapshot.create({ data: input, select: FIELDS });
  }

  async deleteById(projectId: string, id: string): Promise<{ count: number }> {
    return this.db.projectSnapshot.deleteMany({ where: { id, projectId } });
  }

  async deleteForProject(projectId: string): Promise<void> {
    await this.db.projectSnapshot.deleteMany({ where: { projectId } });
  }
}
