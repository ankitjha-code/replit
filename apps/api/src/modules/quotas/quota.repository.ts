import type { QuotaKind } from '@platform/shared';
import type { Database } from '../../db/client.js';

export class QuotaRepository {
  constructor(private readonly db: Database) {}

  countRuntimes(ownerId: string): Promise<number> {
    return this.db.runtime.count({
      where: {
        project: { ownerId },
        status: { in: ['REQUESTED', 'CREATING', 'STARTING', 'RUNNING', 'STOPPING'] },
      },
    });
  }

  countDeployments(ownerId: string): Promise<number> {
    return this.db.deployment.count({
      where: {
        project: { ownerId },
        OR: [
          { status: { in: ['REQUESTED', 'BUILDING', 'STARTING'] } },
          { status: 'RUNNING', target: 'SERVER' },
        ],
      },
    });
  }

  countBuilds(ownerId: string): Promise<number> {
    return this.db.deployment.count({
      where: {
        project: { ownerId },
        status: { in: ['REQUESTED', 'BUILDING'] },
      },
    });
  }

  async ownerOf(projectId: string): Promise<string | null> {
    const found = await this.db.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true },
    });
    return found?.ownerId ?? null;
  }

  async overridesFor(userId: string): Promise<Partial<Record<QuotaKind, number>>> {
    const rows = await this.db.accountQuotaOverride.findMany({
      where: { userId },
      select: { kind: true, limit: true },
    });
    return Object.fromEntries(rows.map((row) => [row.kind, row.limit]));
  }

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
