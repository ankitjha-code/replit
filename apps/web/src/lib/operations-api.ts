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
import { apiRequest } from './api-client.js';

/**
 * The installation, for the people who run it.
 *
 * Every path here answers *not found* to anybody who is not an operator, so a
 * client that reaches them without being one sees the same thing it would see
 * for a route that does not exist. Nothing here returns a project's contents.
 */

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

/** Defaults to the dry run, like the endpoint does. */
export async function runSweep(dryRun: boolean): Promise<SweepReportView> {
  const payload = await apiRequest<unknown>('/api/operations/sweep', {
    method: 'POST',
    body: { dryRun },
  });
  return sweepReportSchema.parse(payload);
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  detail: unknown;
  at: string;
}

/** What operators have done, newest first. Read-only: nothing edits the trail. */
export async function fetchAuditTrail(signal?: AbortSignal): Promise<AuditEntry[]> {
  const payload = await apiRequest<{ entries: AuditEntry[] }>(
    '/api/operations/audit',
    signal ? { signal } : {},
  );
  return payload.entries;
}

/** One account's ceilings, and which are exceptions to the installation's default. */
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

/** A null limit puts the account back on the default. */
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

/** Takes a host out of placement, or puts it back. Returns every host as it now is. */
export async function setHostDrain(hostName: string, draining: boolean): Promise<OperationsHost[]> {
  const payload = await apiRequest<unknown>(
    `/api/operations/hosts/${encodeURIComponent(hostName)}/drain`,
    { method: 'PUT', body: { draining } },
  );
  return operationsHostsResponseSchema.parse(payload).hosts;
}
