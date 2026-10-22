import type { Database } from '../../db/client.js';

/**
 * The only code that reads the installation as a whole.
 *
 * Every query here counts or lists; none of them returns project content. That
 * is not a convention to remember — it is the whole surface, and a query added
 * here that returned a file or a secret would be visible as exactly that.
 */

export interface AccountSummaryRow {
  id: string;
  username: string;
  email: string;
  emailVerifiedAt: Date | null;
  isOperator: boolean;
  createdAt: Date;
  projects: number;
}

export class OperationsRepository {
  constructor(private readonly db: Database) {}

  /**
   * The counts the overview is made of, asked together.
   *
   * One round trip for nine numbers rather than nine. None of them is expensive
   * on its own; a page that made nine sequential queries would be slow for no
   * reason other than how it was written.
   */
  async counts(): Promise<{
    accounts: number;
    verified: number;
    operators: number;
    projects: number;
    runningRuntimes: number;
    liveDeployments: number;
    failedDeployments: number;
    queuedJobs: number;
    runningJobs: number;
    failedJobs: number;
  }> {
    const [
      accounts,
      verified,
      operators,
      projects,
      runningRuntimes,
      liveDeployments,
      failedDeployments,
      queuedJobs,
      runningJobs,
      failedJobs,
    ] = await Promise.all([
      this.db.user.count(),
      this.db.user.count({ where: { emailVerifiedAt: { not: null } } }),
      this.db.user.count({ where: { isOperator: true } }),
      this.db.project.count(),
      this.db.runtime.count({ where: { status: 'RUNNING' } }),
      this.db.deployment.count({ where: { status: 'RUNNING' } }),
      this.db.deployment.count({ where: { status: 'FAILED' } }),
      this.db.job.count({ where: { status: 'QUEUED' } }),
      this.db.job.count({ where: { status: 'RUNNING' } }),
      this.db.job.count({ where: { status: 'FAILED' } }),
    ]);

    return {
      accounts,
      verified,
      operators,
      projects,
      runningRuntimes,
      liveDeployments,
      failedDeployments,
      queuedJobs,
      runningJobs,
      failedJobs,
    };
  }

  /**
   * Accounts, oldest first, paged by identifier.
   *
   * A cursor rather than an offset. These identifiers are UUIDv7, so they sort
   * by creation, and paging by the last one seen cannot skip or repeat a row
   * when accounts are created while somebody is reading — which an offset can,
   * and does exactly when an installation is busy enough for it to matter.
   */
  async accounts(limit: number, after: string | undefined): Promise<AccountSummaryRow[]> {
    const rows = await this.db.user.findMany({
      ...(after ? { where: { id: { gt: after } } } : {}),
      orderBy: { id: 'asc' },
      take: limit,
      select: {
        id: true,
        username: true,
        email: true,
        emailVerifiedAt: true,
        isOperator: true,
        createdAt: true,
        _count: { select: { ownedProjects: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      email: row.email,
      emailVerifiedAt: row.emailVerifiedAt,
      isOperator: row.isOperator,
      createdAt: row.createdAt,
      projects: row._count.ownedProjects,
    }));
  }

  findAccount(id: string): Promise<{ id: string; username: string; isOperator: boolean } | null> {
    return this.db.user.findUnique({
      where: { id },
      select: { id: true, username: true, isOperator: true },
    });
  }

  async setOperator(id: string, isOperator: boolean): Promise<void> {
    await this.db.user.update({ where: { id }, data: { isOperator } });
  }

  /** How many operators there are, for the rule that there must stay one. */
  async setDrained(hostName: string, draining: boolean): Promise<void> {
    if (draining) {
      await this.db.executionHostDrain.upsert({
        where: { hostName },
        create: { hostName },
        update: {},
      });
    } else {
      await this.db.executionHostDrain.deleteMany({ where: { hostName } });
    }
  }

  async drainedHosts(): Promise<Set<string>> {
    const rows = await this.db.executionHostDrain.findMany({ select: { hostName: true } });
    return new Set(rows.map((row) => row.hostName));
  }

  countOperators(): Promise<number> {
    return this.db.user.count({ where: { isOperator: true } });
  }

  /**
   * Writes down something an operator did.
   *
   * Insert only. There is deliberately no update or delete anywhere for this
   * table: a record the people it records could edit is not a record.
   */
  async recordAudit(entry: {
    actorId: string;
    actorName: string;
    action: string;
    targetId?: string | undefined;
    targetName?: string | undefined;
    detail?: Record<string, unknown> | undefined;
  }): Promise<void> {
    await this.db.operatorAuditEntry.create({
      data: {
        actorId: entry.actorId,
        actorName: entry.actorName,
        action: entry.action,
        targetId: entry.targetId ?? null,
        targetName: entry.targetName ?? null,
        ...(entry.detail ? { detail: entry.detail as object } : {}),
      },
    });
  }

  /** The most recent entries, newest first. */
  listAudit(limit: number): Promise<
    {
      id: string;
      actorName: string;
      action: string;
      targetName: string | null;
      detail: unknown;
      createdAt: Date;
    }[]
  > {
    return this.db.operatorAuditEntry.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        actorName: true,
        action: true,
        targetName: true,
        detail: true,
        createdAt: true,
      },
    });
  }

  findUsername(id: string): Promise<{ username: string } | null> {
    return this.db.user.findUnique({ where: { id }, select: { username: true } });
  }
}
