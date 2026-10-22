import { quotaResponseSchema, type QuotaUsage } from '@platform/shared';
import { apiRequest } from './api-client.js';

export async function fetchQuotas(signal?: AbortSignal): Promise<QuotaUsage[]> {
  const payload = await apiRequest<unknown>('/api/quotas', signal ? { signal } : {});
  return quotaResponseSchema.parse(payload).quotas;
}
