import type { Database } from '../../db/client.js';

export interface VariableRecord {
  key: string;
  value: string;
  createdAt: Date;
  updatedAt: Date;
}

const FIELDS = { key: true, value: true, createdAt: true, updatedAt: true } as const;

export class VariableRepository {
  constructor(private readonly db: Database) {}

  listForProject(projectId: string): Promise<VariableRecord[]> {
    return this.db.projectVariable.findMany({
      where: { projectId },
      orderBy: { key: 'asc' },
      select: FIELDS,
    });
  }

  async keysForProject(projectId: string): Promise<string[]> {
    const rows = await this.db.projectVariable.findMany({
      where: { projectId },
      select: { key: true },
    });
    return rows.map((row) => row.key);
  }

  set(input: {
    projectId: string;
    key: string;
    value: string;
    updatedById: string;
  }): Promise<VariableRecord> {
    return this.db.projectVariable.upsert({
      where: { projectId_key: { projectId: input.projectId, key: input.key } },
      create: input,
      update: { value: input.value, updatedById: input.updatedById },
      select: FIELDS,
    });
  }

  deleteByKey(projectId: string, key: string): Promise<{ count: number }> {
    return this.db.projectVariable.deleteMany({ where: { projectId, key } });
  }
}
