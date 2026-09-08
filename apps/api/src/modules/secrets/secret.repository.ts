import type { Database } from '../../db/client.js';

/**
 * The only code that reads or writes the project_secrets table.
 *
 * Two shapes come out of here. A summary, which never includes the encrypted
 * value, and the sealed bytes, which are read by exactly one caller on their
 * way into a container. Keeping them apart makes reading a value something a
 * caller has to ask for deliberately.
 */

export interface SecretSummaryRecord {
  key: string;
  length: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SealedSecretRecord {
  key: string;
  value: Uint8Array;
}

const SUMMARY = { key: true, length: true, createdAt: true, updatedAt: true } as const;

export class SecretRepository {
  constructor(private readonly db: Database) {}

  listForProject(projectId: string): Promise<SecretSummaryRecord[]> {
    return this.db.projectSecret.findMany({
      where: { projectId },
      orderBy: { key: 'asc' },
      select: SUMMARY,
    });
  }

  /** The sealed values, for the one caller that hands them to a container. */
  listSealed(projectId: string): Promise<SealedSecretRecord[]> {
    return this.db.projectSecret.findMany({
      where: { projectId },
      orderBy: { key: 'asc' },
      select: { key: true, value: true },
    });
  }

  countForProject(projectId: string): Promise<number> {
    return this.db.projectSecret.count({ where: { projectId } });
  }

  set(input: {
    projectId: string;
    key: string;
    value: Buffer;
    length: number;
    updatedById: string;
  }): Promise<SecretSummaryRecord> {
    // Copied into a fresh Uint8Array: Prisma's generated input type will not
    // accept a Buffer whose backing store it cannot prove is an ArrayBuffer.
    const value = Uint8Array.from(input.value);

    return this.db.projectSecret.upsert({
      where: { projectId_key: { projectId: input.projectId, key: input.key } },
      create: { ...input, value },
      update: { value, length: input.length, updatedById: input.updatedById },
      select: SUMMARY,
    });
  }

  deleteByKey(projectId: string, key: string): Promise<{ count: number }> {
    return this.db.projectSecret.deleteMany({ where: { projectId, key } });
  }
}
