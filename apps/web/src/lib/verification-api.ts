import {
  passwordResetResponseSchema,
  verificationStatusSchema,
  type PasswordResetComplete,
  type VerificationStatus,
} from '@platform/shared';
import { apiRequest } from './api-client.js';

/**
 * Proving an address, and getting back in without a password.
 *
 * Two of these are reachable without being signed in, which is the point: a
 * link arrives in an inbox and is opened wherever the inbox is, which is very
 * often not the browser holding the session.
 */

export async function fetchVerificationStatus(signal?: AbortSignal): Promise<VerificationStatus> {
  const payload = await apiRequest<unknown>('/api/auth/verification', signal ? { signal } : {});
  return verificationStatusSchema.parse(payload);
}

export async function sendVerificationEmail(): Promise<void> {
  await apiRequest<unknown>('/api/auth/verification/send', { method: 'POST' });
}

export async function confirmVerification(token: string): Promise<void> {
  await apiRequest<unknown>('/api/auth/verification/confirm', {
    method: 'POST',
    body: { token },
  });
}

/**
 * Asks for a reset link, and learns nothing from the answer.
 *
 * Always resolves when the server accepted the request, which it does whether or
 * not the address has an account. The page says the same thing either way,
 * because the alternative is a way to find out who has an account here.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const payload = await apiRequest<unknown>('/api/auth/password-reset', {
    method: 'POST',
    body: { email },
  });
  passwordResetResponseSchema.parse(payload);
}

export async function completePasswordReset(input: PasswordResetComplete): Promise<void> {
  await apiRequest<unknown>('/api/auth/password-reset/complete', {
    method: 'POST',
    body: input,
  });
}
