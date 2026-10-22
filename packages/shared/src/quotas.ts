import { z } from 'zod';

export const QUOTA_KINDS = ['RUNTIMES', 'DEPLOYMENTS', 'BUILDS'] as const;

export type QuotaKind = (typeof QUOTA_KINDS)[number];

export const QUOTA_LABELS: Readonly<Record<QuotaKind, string>> = {
  RUNTIMES: 'Environments running',
  DEPLOYMENTS: 'Deployments live',
  BUILDS: 'Builds in progress',
};

export const quotaUsageSchema = z.object({
  kind: z.enum(QUOTA_KINDS),
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});

export type QuotaUsage = z.infer<typeof quotaUsageSchema>;

export const quotaResponseSchema = z.object({
  quotas: z.array(quotaUsageSchema),
});

export type QuotaResponse = z.infer<typeof quotaResponseSchema>;

export function isQuotaFull(usage: QuotaUsage): boolean {
  return usage.used >= usage.limit;
}

export const accountQuotaSchema = quotaUsageSchema.extend({
  defaultLimit: z.number().int().positive(),
  overridden: z.boolean(),
});

export type AccountQuota = z.infer<typeof accountQuotaSchema>;

export const accountQuotaResponseSchema = z.object({ quotas: z.array(accountQuotaSchema) });

export const MAX_QUOTA_OVERRIDE = 200;

export const setQuotaOverrideRequestSchema = z.object({
  kind: z.enum(QUOTA_KINDS),
  limit: z.number().int().min(1).max(MAX_QUOTA_OVERRIDE).nullable(),
});

export type SetQuotaOverrideRequest = z.infer<typeof setQuotaOverrideRequestSchema>;
