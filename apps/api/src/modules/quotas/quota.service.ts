import { QUOTA_KINDS, type AccountQuota, type QuotaKind, type QuotaUsage } from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { QuotaRepository } from './quota.repository.js';

/**
 * How much of the platform one account may be using at once.
 *
 * The ceilings so far have all been about size — how large a file, how much
 * memory one container gets — and each bounds a single thing. This bounds how
 * many things at once, which is the only kind of limit that stops one account
 * filling a machine everybody shares.
 *
 * The scheduler's host capacity is not a substitute. It stops the platform
 * overcommitting a machine and says nothing about who filled it: somebody who
 * starts twenty projects is refused eventually, having already taken the room
 * from everybody else. A per-account ceiling is what makes "eventually" happen
 * to the right person.
 *
 * ## Checked before anything is written
 *
 * Every refusal here happens before a row is created, following the rule the
 * runtime and database services already set: a platform that cannot do something
 * must not accumulate records describing it having been asked.
 *
 * ## And it is advisory against a race
 *
 * Two requests can both pass the check and both create a runtime. That is
 * accepted rather than fixed with a lock, because the cost of being one over a
 * ceiling for a moment is nothing, and the cost of a lock on every start is a
 * platform that serialises the thing people do most. The host capacity check
 * further down is the one that must not be raced, and it is a conditional
 * insert's job rather than this.
 */

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

  /** What an account is using, and what it may use. */
  async describe(ownerId: string): Promise<QuotaUsage[]> {
    const detailed = await this.describeForOperator(ownerId);
    return detailed.map(({ kind, used, limit }) => ({ kind, used, limit }));
  }

  /**
   * The same, with where each ceiling came from.
   *
   * For operators only: an account holder sees the number they are held to, and
   * whether it is the installation's rule or an exception made for them is not
   * something they need in order to act on it.
   */
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

  /** Sets or clears one account's ceiling for one kind. Operators only; the caller checks. */
  async setOverride(userId: string, kind: QuotaKind, limit: number | null): Promise<void> {
    await this.quotas.setOverride(userId, kind, limit);
    this.log.warn({ userId, kind, limit }, 'an account ceiling was changed');
  }

  /**
   * Refuses when an account is already at its ceiling for this kind.
   *
   * Takes a project rather than an account, because every caller has one and
   * none of them should have to know that the limit is charged to its owner.
   * That is this service's rule to keep, and keeping it in one place is what
   * stops it being applied differently in two.
   */
  async require(projectId: string, kind: QuotaKind): Promise<void> {
    const ownerId = await this.quotas.ownerOf(projectId);

    if (!ownerId) {
      // The project went away between the request and here. Nothing to charge
      // and nothing to refuse; whatever happens next will fail on its own terms.
      return;
    }

    // An operator's exception for this account, if there is one. Read on every
    // check rather than cached, so lowering a ceiling takes effect at once.
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

/**
 * What a refusal says.
 *
 * Each names what is full and what would free it, because the thing to do about
 * a concurrency limit is always the same — stop something — and a message that
 * only said "limit reached" would leave somebody looking for a settings page
 * that does not exist.
 */
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
