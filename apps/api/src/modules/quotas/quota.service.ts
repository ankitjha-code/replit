import { QUOTA_KINDS, type AccountQuota, type QuotaKind, type QuotaUsage } from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { QuotaRepository } from './quota.repository.js';

export interface QuotaLimits {
  RUNTIMES: number;
  DEPLOYMENTS: number;
  BUILDS: number;
}

export class QuotaService {
  constructor(
    private readonly quotas: QuotaRepository,
    private readonly limits: QuotaLimits,
    private readonly log: Logger,
  ) {}

  async describe(ownerId: string): Promise<QuotaUsage[]> {
    const detailed = await this.describeForOperator(ownerId);
    return detailed.map(({ kind, used, limit }) => ({ kind, used, limit }));
  }

  async describeForOperator(ownerId: string): Promise<AccountQuota[]> {
    const [runtimes, deployments, builds, overrides] = await Promise.all([
      this.quotas.countRuntimes(ownerId),
      this.quotas.countDeployments(ownerId),
      this.quotas.countBuilds(ownerId),
      this.quotas.overridesFor(ownerId),
    ]);

    const used: Record<QuotaKind, number> = {
      RUNTIMES: runtimes,
      DEPLOYMENTS: deployments,
      BUILDS: builds,
    };

    return QUOTA_KINDS.map((kind) => ({
      kind,
      used: used[kind],
      limit: overrides[kind] ?? this.limits[kind],
      defaultLimit: this.limits[kind],
      overridden: overrides[kind] !== undefined,
    }));
  }

  async setOverride(userId: string, kind: QuotaKind, limit: number | null): Promise<void> {
    await this.quotas.setOverride(userId, kind, limit);
    this.log.warn({ userId, kind, limit }, 'an account ceiling was changed');
  }

  async require(projectId: string, kind: QuotaKind): Promise<void> {
    const ownerId = await this.quotas.ownerOf(projectId);

    if (!ownerId) {
      return;
    }

    const overrides = await this.quotas.overridesFor(ownerId);
    const limit = overrides[kind] ?? this.limits[kind];
    const used = await this.count(ownerId, kind);

    if (used < limit) return;

    this.log.info({ ownerId, projectId, kind, used, limit }, 'a concurrency limit refused work');

    throw new AppError('CONFLICT', message(kind, limit), {
      expose: true,
      details: { kind, used, limit },
    });
  }

  private count(ownerId: string, kind: QuotaKind): Promise<number> {
    switch (kind) {
      case 'RUNTIMES':
        return this.quotas.countRuntimes(ownerId);
      case 'DEPLOYMENTS':
        return this.quotas.countDeployments(ownerId);
      case 'BUILDS':
        return this.quotas.countBuilds(ownerId);
    }
  }
}

function message(kind: QuotaKind, limit: number): string {
  switch (kind) {
    case 'RUNTIMES':
      return `You already have ${String(limit)} environments running, which is as many as you may have at once. Stop one you are not using.`;
    case 'DEPLOYMENTS':
      return `You already have ${String(limit)} deployments live, which is as many as you may have at once. Stop one first.`;
    case 'BUILDS':
      return `You already have ${String(limit)} builds in progress. Wait for one to finish before starting another.`;
  }
}
