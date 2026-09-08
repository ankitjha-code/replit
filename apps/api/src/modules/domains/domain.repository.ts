import type { DomainStatus } from '@platform/shared';
import type { Database } from '../../db/client.js';

/**
 * The only code that reads or writes the project_domains table, and the one
 * column on projects that names a deployment's address.
 *
 * They are together because they answer one question from two directions:
 * "which project does this hostname belong to". A request arriving on a custom
 * domain is looked up here; a request arriving on the platform's own domain is
 * looked up by the label beside it.
 */

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

/** Postgres unique-violation code, surfaced as a result rather than an error. */
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
    // Scoped to the project as well as the id, so an identifier from one
    // project can never address another's.
    return this.db.projectDomain.findFirst({ where: { id, projectId }, select: FIELDS });
  }

  /**
   * The project a hostname belongs to, if it is verified.
   *
   * Only verified ones, and that is the whole point of the status: a pending
   * domain is a claim, and serving on a claim would hand somebody else's
   * traffic to whoever typed the name first.
   */
  findVerified(hostname: string): Promise<DomainRecord | null> {
    return this.db.projectDomain.findFirst({
      where: { hostname: hostname.toLowerCase(), status: 'VERIFIED' },
      select: FIELDS,
    });
  }

  /**
   * Verified domains not re-checked since a moment, oldest check first.
   *
   * Bounded per pass, so an installation with thousands of domains spreads the
   * lookups across several passes rather than firing them all at once at a
   * resolver.
   */
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

  /** A re-check that found it still pointing here. */
  async recordStillPointing(id: string): Promise<void> {
    await this.db.projectDomain.update({
      where: { id },
      data: { lastCheckedAt: new Date(), consecutiveMisses: 0 },
    });
  }

  /** A re-check that did not, with the running count. */
  async recordMiss(id: string, misses: number): Promise<void> {
    await this.db.projectDomain.update({
      where: { id },
      data: { lastCheckedAt: new Date(), consecutiveMisses: misses },
    });
  }

  countForProject(projectId: string): Promise<number> {
    return this.db.projectDomain.count({ where: { projectId } });
  }

  /**
   * Claims a hostname, or reports that somebody already has.
   *
   * A conflict is an ordinary outcome rather than an error: two people may
   * legitimately try to add the same name, and only one of them can own it.
   * The unique index is what decides, not the check before it.
   */
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

  // --- The platform's own subdomains ---------------------------------------

  /** The project a label under the platform's domain belongs to. */
  /** Whether a project with this identifier exists. A malformed id is simply "no". */
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

  /** Sets the label, or reports that somebody already holds it. */
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

  /** The project's slug, which is what a default subdomain is derived from. */
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
