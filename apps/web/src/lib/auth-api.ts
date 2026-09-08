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

/**
 * Calls that establish or end a session.
 *
 * Responses are parsed against the shared schemas rather than trusted, so a
 * server change that breaks the contract surfaces here instead of as a
 * confusing render further down. The session itself never appears in any of
 * these values: it lives in an httpOnly cookie the browser cannot read.
 */

export async function registerAccount(input: RegisterRequest): Promise<AuthenticatedResponse> {
  const payload = await apiRequest<unknown>('/api/auth/register', {
    method: 'POST',
    body: input,
  });
  return authenticatedResponseSchema.parse(payload);
}

/**
 * Signs in, or learns that a second factor is owed.
 *
 * For an account with two-factor sign-in the password alone answers with a
 * challenge and no session; `completeTwoFactor` finishes it with a code.
 */
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

/** Who the caller is, or null. Not signed in is an ordinary answer, not an error. */
export async function fetchCurrentUser(signal?: AbortSignal): Promise<PublicUser | null> {
  const payload = await apiRequest<unknown>('/api/auth/me', signal ? { signal } : {});
  return currentUserResponseSchema.parse(payload).user;
}
