import type { QuotaKind } from '@platform/shared';
import type { Database } from '../../db/client.js';

/**
 * How much of the platform one account is using right now.
 *
 * Counted through project ownership, which is what makes this an account limit
 * rather than a project one: a container belongs to a project, and a project
 * belongs to an account, and the account is what a ceiling has to be about.
 *
 * Every count is of things **currently occupying something**. A stopped runtime
 * and a finished deployment have given their room back; counting them would
 * refuse work because of containers that no longer exist, which is the failure
 * mode that makes people distrust a quota.
 */
export class QuotaRepository {
  constructor(private readonly db: Database) {}

  /**
   * Development containers this account has running or coming up.
   *
   * `REQUESTED` and the transitional states count. A runtime whose container is
   * being created is already spoken for, and leaving it out would let somebody
   * start ten projects in the same second and be under the limit for all of
   * them.
   */
  countRuntimes(ownerId: string): Promise<number> {
    return this.db.runtime.count({
      where: {
        project: { ownerId },
        status: { in: ['REQUESTED', 'CREATING', 'STARTING', 'RUNNING', 'STOPPING'] },
      },
    });
  }

  /** Deployments serving, or on their way to serving. */
  countDeployments(ownerId: string): Promise<number> {
    return this.db.deployment.count({
      where: {
        project: { ownerId },
        OR: [
          // Anything on its way up occupies a build or a start.
          { status: { in: ['REQUESTED', 'BUILDING', 'STARTING'] } },
          // Once running, only a server occupies anything: a published static
          // site is files the platform serves, with no container behind it.
          { status: 'RUNNING', target: 'SERVER' },
        ],
      },
    });
  }

  /**
   * Builds in flight.
   *
   * Counted separately from deployments, and limited more tightly, because they
   * are not the same cost at all: a running deployment is a container sitting
   * there, and a build is a machine installing dependencies flat out. Somebody
   * with five deployments is using five containers; somebody who redeploys five
   * projects at once is using the whole host.
   */
  countBuilds(ownerId: string): Promise<number> {
    return this.db.deployment.count({
      where: {
        project: { ownerId },
        status: { in: ['REQUESTED', 'BUILDING'] },
      },
    });
  }

  /** Who a project belongs to, which is the account a limit is charged to. */
  async ownerOf(projectId: string): Promise<string | null> {
    const found = await this.db.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true },
    });
    return found?.ownerId ?? null;
  }

  /** An operator's ceilings for one account, by kind. Missing kinds use the default. */
  async overridesFor(userId: string): Promise<Partial<Record<QuotaKind, number>>> {
    const rows = await this.db.accountQuotaOverride.findMany({
      where: { userId },
      select: { kind: true, limit: true },
    });
    return Object.fromEntries(rows.map((row) => [row.kind, row.limit]));
  }

  /** Sets one ceiling, or with null removes it so the default applies again. */
  async setOverride(userId: string, kind: QuotaKind, limit: number | null): Promise<void> {
    if (limit === null) {
      await this.db.accountQuotaOverride.deleteMany({ where: { userId, kind } });
      return;
    }
    await this.db.accountQuotaOverride.upsert({
      where: { userId_kind: { userId, kind } },
      create: { userId, kind, limit },
      update: { limit },
    });
  }
}
