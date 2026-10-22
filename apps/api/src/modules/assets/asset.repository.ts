import type { Database } from '../../db/client.js';

/** The only code that reads or writes the project_assets table. */

export interface AssetRecord {
  id: string;
  projectId: string;
  storageKey: string;
  name: string;
  contentType: string;
  size: number;
  checksum: string;
  createdAt: Date;
}

const FIELDS = {
  id: true,
  projectId: true,
  storageKey: true,
  name: true,
  contentType: true,
  size: true,
  checksum: true,
  createdAt: true,
} as const;

export class AssetRepository {
  constructor(private readonly db: Database) {}

  listForProject(projectId: string): Promise<AssetRecord[]> {
    return this.db.projectAsset.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: FIELDS,
    });
  }

  findById(projectId: string, id: string): Promise<AssetRecord | null> {
    // Scoped by project as well as by id, so an identifier from one project
    // cannot address another's file even if one leaks.
    return this.db.projectAsset.findFirst({ where: { id, projectId }, select: FIELDS });
  }

  create(input: {
    projectId: string;
    storageKey: string;
    name: string;
    contentType: string;
    size: number;
    checksum: string;
    uploadedById: string;
  }): Promise<AssetRecord> {
    return this.db.projectAsset.create({ data: input, select: FIELDS });
  }

  deleteById(projectId: string, id: string): Promise<{ count: number }> {
    return this.db.projectAsset.deleteMany({ where: { id, projectId } });
  }

  /** Bytes already used by a project, for the quota check. */
  async totalBytes(projectId: string): Promise<number> {
    const result = await this.db.projectAsset.aggregate({
      where: { projectId },
      _sum: { size: true },
    });
    return result._sum.size ?? 0;
  }
}
