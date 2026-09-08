import type { Database } from '../../db/client.js';

/**
 * The only code that reads or writes the project_variables table.
 *
 * One shape comes out of here, and it includes the value. That is the whole
 * difference from the secret repository next door, where reading a value is
 * something a caller has to ask for deliberately and only one caller may.
 */

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

  /** Just the names, for checking whether one is already taken. */
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
