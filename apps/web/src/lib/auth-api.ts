import {
  authenticatedResponseSchema,
  loginResponseSchema,
  type LoginResponse,
  currentUserResponseSchema,
  type AuthenticatedResponse,
  type LoginRequest,
  type PublicUser,
  type RegisterRequest,
} from '@platform/shared';
import { apiRequest } from './api-client.js';

export const TWO_FACTOR_CHALLENGE_TTL_MS = 5 * 60_000;

export async function registerAccount(input: RegisterRequest): Promise<AuthenticatedResponse> {
  const payload = await apiRequest<unknown>('/api/auth/register', {
    method: 'POST',
    body: input,
  });
  return authenticatedResponseSchema.parse(payload);
}

export async function signIn(input: LoginRequest): Promise<LoginResponse> {
  const payload = await apiRequest<unknown>('/api/auth/login', { method: 'POST', body: input });
  return loginResponseSchema.parse(payload);
}

export async function completeTwoFactor(
  challenge: string,
  code: string,
): Promise<AuthenticatedResponse> {
  const payload = await apiRequest<unknown>('/api/auth/login/two-factor', {
    method: 'POST',
    body: { challenge, code },
  });
  return authenticatedResponseSchema.parse(payload);
}

export async function signOut(): Promise<void> {
  await apiRequest<void>('/api/auth/logout', { method: 'POST' });
}

export async function signOutEverywhere(): Promise<void> {
  await apiRequest<void>('/api/auth/logout-all', { method: 'POST' });
}

export async function fetchCurrentUser(signal?: AbortSignal): Promise<PublicUser | null> {
  const payload = await apiRequest<unknown>('/api/auth/me', signal ? { signal } : {});
  return currentUserResponseSchema.parse(payload).user;
}
