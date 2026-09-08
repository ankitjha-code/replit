import { quotaResponseSchema, type QuotaUsage } from '@platform/shared';
import { apiRequest } from './api-client.js';

/**
 * How much of the platform this account is using at once.
 *
 * Answers only about the signed-in account. There is no way to ask about
 * somebody else's usage, which would be a way to learn how much of a shared
 * machine other people are taking.
 */
export async function fetchQuotas(signal?: AbortSignal): Promise<QuotaUsage[]> {
  const payload = await apiRequest<unknown>('/api/quotas', signal ? { signal } : {});
  return quotaResponseSchema.parse(payload).quotas;
}
