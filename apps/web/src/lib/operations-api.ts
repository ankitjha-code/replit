import {
  accountQuotaResponseSchema,
  operationsAccountsResponseSchema,
  operationsHostsResponseSchema,
  operationsOverviewSchema,
  sweepReportSchema,
  type AccountQuota,
  type OperationsAccount,
  type OperationsHost,
  type OperationsOverview,
  type QuotaKind,
  type SweepReportView,
} from '@platform/shared';
import { z } from 'zod';
import { apiRequest } from './api-client.js';

export async function fetchOverview(signal?: AbortSignal): Promise<OperationsOverview> {
  const payload = await apiRequest<unknown>('/api/operations/overview', signal ? { signal } : {});
  return operationsOverviewSchema.parse(payload);
}

export async function fetchHosts(signal?: AbortSignal): Promise<OperationsHost[]> {
  const payload = await apiRequest<unknown>('/api/operations/hosts', signal ? { signal } : {});
  return operationsHostsResponseSchema.parse(payload).hosts;
}

export async function fetchAccounts(
  after?: string,
  signal?: AbortSignal,
): Promise<{ accounts: OperationsAccount[]; nextCursor: string | null }> {
  const query = after ? `?after=${encodeURIComponent(after)}` : '';
  const payload = await apiRequest<unknown>(
    `/api/operations/accounts${query}`,
    signal ? { signal } : {},
  );
  return operationsAccountsResponseSchema.parse(payload);
}

export async function setOperator(accountId: string, isOperator: boolean): Promise<void> {
  await apiRequest<unknown>(`/api/operations/accounts/${encodeURIComponent(accountId)}/operator`, {
    method: 'PUT',
    body: { isOperator },
  });
}

export async function runSweep(dryRun: boolean): Promise<SweepReportView> {
  const payload = await apiRequest<unknown>('/api/operations/sweep', {
    method: 'POST',
    body: { dryRun },
  });
  return sweepReportSchema.parse(payload);
}

export const auditEntrySchema = z.object({
  id: z.string(),
  actor: z.string(),
  action: z.string(),
  target: z.string().nullable(),
  detail: z.unknown(),
  at: z.string(),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditTrailResponseSchema = z.object({
  entries: z.array(auditEntrySchema),
});

export async function fetchAuditTrail(signal?: AbortSignal): Promise<AuditEntry[]> {
  const payload = await apiRequest<unknown>('/api/operations/audit', signal ? { signal } : {});
  return auditTrailResponseSchema.parse(payload).entries;
}

export async function fetchAccountQuotas(
  accountId: string,
  signal?: AbortSignal,
): Promise<AccountQuota[]> {
  const payload = await apiRequest<unknown>(
    `/api/operations/accounts/${encodeURIComponent(accountId)}/quotas`,
    signal ? { signal } : {},
  );
  return accountQuotaResponseSchema.parse(payload).quotas;
}

export async function setAccountQuota(
  accountId: string,
  kind: QuotaKind,
  limit: number | null,
): Promise<AccountQuota[]> {
  const payload = await apiRequest<unknown>(
    `/api/operations/accounts/${encodeURIComponent(accountId)}/quotas`,
    { method: 'PUT', body: { kind, limit } },
  );
  return accountQuotaResponseSchema.parse(payload).quotas;
}

export async function setHostDrain(hostName: string, draining: boolean): Promise<OperationsHost[]> {
  const payload = await apiRequest<unknown>(
    `/api/operations/hosts/${encodeURIComponent(hostName)}/drain`,
    { method: 'PUT', body: { draining } },
  );
  return operationsHostsResponseSchema.parse(payload).hosts;
}
