import type { SnapshotKind } from '@platform/shared';
import type { Database } from '../../db/client.js';

/**
 * The only code that reads or writes the project_snapshots table.
 *
 * There is no update method, and that is the design rather than an omission: a
 * snapshot that could be edited is not a record of anything.
 */

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

  /** Newest first, which is the order somebody looks for a snapshot in. */
  listForProject(projectId: string): Promise<SnapshotRecord[]> {
    return this.db.projectSnapshot.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: FIELDS,
    });
  }

  findById(projectId: string, id: string): Promise<SnapshotRecord | null> {
    // Scoped to the project as well as the id, so an identifier from one
    // project can never address another's.
    return this.db.projectSnapshot.findFirst({ where: { id, projectId }, select: FIELDS });
  }

  /**
   * How many of one kind a project holds.
   *
   * The two kinds are counted separately because they are limited separately:
   * what a person may keep, and what the platform keeps on their behalf.
   */
  countForProject(projectId: string, kind: SnapshotKind): Promise<number> {
    return this.db.projectSnapshot.count({ where: { projectId, kind } });
  }

  /**
   * The oldest of one kind, which is the one pruning removes first.
   *
   * `exceptId` leaves one out. Pruning happens during a restore, and the
   * snapshot being restored from must survive being made room for.
   */
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

  /** Every storage key a project holds, for removing them all at once. */
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
