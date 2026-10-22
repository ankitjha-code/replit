import type { DomainStatus } from '@platform/shared';
import type { Database } from '../../db/client.js';

export interface DomainRecord {
  id: string;
  projectId: string;
  hostname: string;
  status: DomainStatus;
  verificationToken: string;
  message: string | null;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  consecutiveMisses: number;
  createdAt: Date;
}

const FIELDS = {
  id: true,
  projectId: true,
  hostname: true,
  status: true,
  verificationToken: true,
  message: true,
  verifiedAt: true,
  lastCheckedAt: true,
  consecutiveMisses: true,
  createdAt: true,
} as const;

const UNIQUE_VIOLATION = 'P2002';

export type AddDomainResult = { ok: true; domain: DomainRecord } | { ok: false; conflict: true };

export class DomainRepository {
  constructor(private readonly db: Database) {}

  listForProject(projectId: string): Promise<DomainRecord[]> {
    return this.db.projectDomain.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      select: FIELDS,
    });
  }

  findById(projectId: string, id: string): Promise<DomainRecord | null> {
    return this.db.projectDomain.findFirst({ where: { id, projectId }, select: FIELDS });
  }

  findVerified(hostname: string): Promise<DomainRecord | null> {
    return this.db.projectDomain.findFirst({
      where: { hostname: hostname.toLowerCase(), status: 'VERIFIED' },
      select: FIELDS,
    });
  }

  listDueForRecheck(before: Date, limit: number): Promise<DomainRecord[]> {
    return this.db.projectDomain.findMany({
      where: {
        status: 'VERIFIED',
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: before } }],
      },
      orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: limit,
      select: FIELDS,
    });
  }

  async recordStillPointing(id: string): Promise<void> {
    await this.db.projectDomain.update({
      where: { id },
      data: { lastCheckedAt: new Date(), consecutiveMisses: 0 },
    });
  }

  async recordMiss(id: string, misses: number): Promise<void> {
    await this.db.projectDomain.update({
      where: { id },
      data: { lastCheckedAt: new Date(), consecutiveMisses: misses },
    });
  }

  countForProject(projectId: string): Promise<number> {
    return this.db.projectDomain.count({ where: { projectId } });
  }

  async add(input: {
    projectId: string;
    hostname: string;
    verificationToken: string;
  }): Promise<AddDomainResult> {
    try {
      const domain = await this.db.projectDomain.create({ data: input, select: FIELDS });
      return { ok: true, domain };
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false, conflict: true };
      throw error;
    }
  }

  async recordCheck(
    id: string,
    input: { status: DomainStatus; message: string | null; verifiedAt?: Date | null },
  ): Promise<DomainRecord> {
    return this.db.projectDomain.update({
      where: { id },
      data: {
        status: input.status,
        message: input.message,
        lastCheckedAt: new Date(),
        ...(input.verifiedAt === undefined ? {} : { verifiedAt: input.verifiedAt }),
      },
      select: FIELDS,
    });
  }

  async remove(projectId: string, id: string): Promise<void> {
    await this.db.projectDomain.deleteMany({ where: { id, projectId } });
  }

  async projectExists(projectId: string): Promise<boolean> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      return false;
    }
    const found = await this.db.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    return found !== null;
  }

  async projectIdForSubdomain(subdomain: string): Promise<string | null> {
    const found = await this.db.project.findUnique({
      where: { deploymentSubdomain: subdomain.toLowerCase() },
      select: { id: true },
    });
    return found?.id ?? null;
  }

  async subdomainOf(projectId: string): Promise<string | null> {
    const found = await this.db.project.findUnique({
      where: { id: projectId },
      select: { deploymentSubdomain: true },
    });
    return found?.deploymentSubdomain ?? null;
  }

  async subdomainTaken(subdomain: string): Promise<boolean> {
    const found = await this.db.project.findUnique({
      where: { deploymentSubdomain: subdomain.toLowerCase() },
      select: { id: true },
    });
    return found !== null;
  }

  async setSubdomain(projectId: string, subdomain: string): Promise<{ ok: boolean }> {
    try {
      await this.db.project.update({
        where: { id: projectId },
        data: { deploymentSubdomain: subdomain.toLowerCase() },
      });
      return { ok: true };
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false };
      throw error;
    }
  }

  async slugOf(projectId: string): Promise<string | null> {
    const found = await this.db.project.findUnique({
      where: { id: projectId },
      select: { slug: true },
    });
    return found?.slug ?? null;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}
