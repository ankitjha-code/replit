import { z } from 'zod';

/**
 * How much of the platform one account may be using at once.
 *
 * Distinct from every other limit in this codebase, and the distinction is worth
 * being precise about. The limits so far have been about **size**: how large a
 * file may be, how many snapshots a project may keep, how much memory one
 * container gets. Those bound a single thing. This bounds how many things at
 * once, which is the only kind of limit that stops one account from filling a
 * machine everybody shares.
 *
 * A host has a capacity ceiling too, from the scheduler, and it is not a
 * substitute: it stops the platform overcommitting a machine, and does nothing
 * about which account filled it. Somebody who starts twenty projects gets
 * refused by the scheduler eventually, having already taken the room from
 * everybody else.
 *
 * ## Charged to the project's owner
 *
 * A project can be shared, so "whose is this container" has more than one
 * plausible answer: the person who pressed Start, or the account the project
 * belongs to. It is the owner, because that is the account the project's storage,
 * database and deployments are already charged to, and because the alternative
 * would let an account raise its own ceiling by being added to other people's
 * projects.
 */

/** What is being counted. */
export const QUOTA_KINDS = [
  /** Development containers running or coming up. */
  'RUNTIMES',
  /** Deployments serving or on their way to serving. */
  'DEPLOYMENTS',
  /** Builds in flight, which are the most expensive thing to have several of. */
  'BUILDS',
] as const;

export type QuotaKind = (typeof QUOTA_KINDS)[number];

export const QUOTA_LABELS: Readonly<Record<QuotaKind, string>> = {
  RUNTIMES: 'Environments running',
  DEPLOYMENTS: 'Deployments live',
  BUILDS: 'Builds in progress',
};

export const quotaUsageSchema = z.object({
  kind: z.enum(QUOTA_KINDS),
  /** How many this account is using right now. */
  used: z.number().int().nonnegative(),
  /** How many it may use at once. */
  limit: z.number().int().positive(),
});

export type QuotaUsage = z.infer<typeof quotaUsageSchema>;

export const quotaResponseSchema = z.object({
  quotas: z.array(quotaUsageSchema),
});

export type QuotaResponse = z.infer<typeof quotaResponseSchema>;

/** True when one more of this kind would be refused. */
export function isQuotaFull(usage: QuotaUsage): boolean {
  return usage.used >= usage.limit;
}

/**
 * One account's ceilings, as an operator sees them.
 *
 * The installation's defaults apply to everybody; an operator can raise or
 * lower one kind for one account — the team running a workshop, the account
 * that keeps starting things by script. `defaultLimit` is shown beside the
 * effective limit so an override is never mistaken for the rule.
 */
export const accountQuotaSchema = quotaUsageSchema.extend({
  defaultLimit: z.number().int().positive(),
  overridden: z.boolean(),
});

export type AccountQuota = z.infer<typeof accountQuotaSchema>;

export const accountQuotaResponseSchema = z.object({ quotas: z.array(accountQuotaSchema) });

/** At most this many of one kind, for one account. A typo should not mean a thousand builds. */
export const MAX_QUOTA_OVERRIDE = 200;

export const setQuotaOverrideRequestSchema = z.object({
  kind: z.enum(QUOTA_KINDS),
  /** Null puts the account back on the installation's default. */
  limit: z.number().int().min(1).max(MAX_QUOTA_OVERRIDE).nullable(),
});

export type SetQuotaOverrideRequest = z.infer<typeof setQuotaOverrideRequestSchema>;
