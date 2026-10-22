import {
  changePasswordResponseSchema,
  deleteAccountResponseSchema,
  sessionListResponseSchema,
  twoFactorConfirmResponseSchema,
  twoFactorSetupResponseSchema,
  twoFactorStatusSchema,
  type TwoFactorSetupResponse,
  type TwoFactorStatus,
  revokeSessionsResponseSchema,
  type AccountSession,
  type ChangePasswordRequest,
  type DeleteAccountRequest,
} from '@platform/shared';
import { apiRequest } from './api-client.js';

export async function fetchSessions(signal?: AbortSignal): Promise<AccountSession[]> {
  const payload = await apiRequest<unknown>('/api/account/sessions', signal ? { signal } : {});
  return sessionListResponseSchema.parse(payload).sessions;
}

export async function changePassword(input: ChangePasswordRequest): Promise<number> {
  const payload = await apiRequest<unknown>('/api/account/password', {
    method: 'POST',
    body: input,
  });
  return changePasswordResponseSchema.parse(payload).signedOut;
}

export async function revokeSession(sessionId: string): Promise<void> {
  await apiRequest<unknown>(`/api/account/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
}

export async function revokeOtherSessions(): Promise<number> {
  const payload = await apiRequest<unknown>('/api/account/sessions/revoke-others', {
    method: 'POST',
  });
  return revokeSessionsResponseSchema.parse(payload).signedOut;
}

export async function deleteAccount(input: DeleteAccountRequest): Promise<number> {
  const payload = await apiRequest<unknown>('/api/account', { method: 'DELETE', body: input });
  return deleteAccountResponseSchema.parse(payload).projectsDeleted;
}

export async function fetchTwoFactorStatus(signal?: AbortSignal): Promise<TwoFactorStatus> {
  const payload = await apiRequest<unknown>('/api/account/two-factor', signal ? { signal } : {});
  return twoFactorStatusSchema.parse(payload);
}

export async function beginTwoFactor(): Promise<TwoFactorSetupResponse> {
  const payload = await apiRequest<unknown>('/api/account/two-factor/setup', { method: 'POST' });
  return twoFactorSetupResponseSchema.parse(payload);
}

export async function confirmTwoFactor(code: string): Promise<string[]> {
  const payload = await apiRequest<unknown>('/api/account/two-factor/confirm', {
    method: 'POST',
    body: { code },
  });
  return twoFactorConfirmResponseSchema.parse(payload).recoveryCodes;
}

export async function disableTwoFactor(password: string, code: string): Promise<void> {
  await apiRequest<unknown>('/api/account/two-factor/disable', {
    method: 'POST',
    body: { password, code },
  });
}
