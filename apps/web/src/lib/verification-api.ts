import {
  publicHealthResponseSchema,
  passwordResetResponseSchema,
  verificationStatusSchema,
  type PasswordResetComplete,
  type VerificationStatus,
} from '@platform/shared';
import { apiRequest } from './api-client.js';

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

export interface MailAvailability {
  configured: boolean;
  up: boolean;
}

export async function fetchMailAvailability(signal?: AbortSignal): Promise<MailAvailability> {
  const payload = await apiRequest<unknown>('/health/ready', signal ? { signal } : {});
  const mail = publicHealthResponseSchema
    .parse(payload)
    .dependencies.find((dependency) => dependency.name === 'mail');
  return { configured: mail !== undefined, up: mail?.status !== 'down' };
}
