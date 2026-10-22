import { z } from 'zod';
import { authenticatedResponseSchema } from './auth.js';

/**
 * A second factor at sign-in.
 *
 * Signing in with one on is two requests: the password, which answers with a
 * short-lived challenge rather than a session, and then a code against that
 * challenge, which answers with the session. The first alone opens nothing.
 */

/** What signing in answers: a session, or a request for a code. */
export const loginResponseSchema = z.union([
  authenticatedResponseSchema,
  z.object({
    twoFactorRequired: z.literal(true),
    /** Carried to the second request. Short-lived and single-use; not a session. */
    challenge: z.string(),
  }),
]);

export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const twoFactorLoginRequestSchema = z.object({
  challenge: z.string().min(1),
  /** Six digits from the app, or a recovery code. */
  code: z.string().trim().min(6).max(32),
});

export type TwoFactorLoginRequest = z.infer<typeof twoFactorLoginRequestSchema>;

export const twoFactorStatusSchema = z.object({
  enabled: z.boolean(),
  recoveryCodesLeft: z.number().int().min(0),
  /** False when the installation has nowhere safe to keep the secret. */
  available: z.boolean(),
});

export type TwoFactorStatus = z.infer<typeof twoFactorStatusSchema>;

export const twoFactorSetupResponseSchema = z.object({
  /** For typing into an app by hand. */
  secret: z.string(),
  /** For an app to open directly: `otpauth://totp/…`. */
  uri: z.string(),
});

export type TwoFactorSetupResponse = z.infer<typeof twoFactorSetupResponseSchema>;

export const twoFactorConfirmRequestSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the six digits your app shows'),
});

export const twoFactorConfirmResponseSchema = z.object({
  /** Shown once. Each works one time, instead of a code from the app. */
  recoveryCodes: z.array(z.string()),
});

export type TwoFactorConfirmResponse = z.infer<typeof twoFactorConfirmResponseSchema>;

export const twoFactorDisableRequestSchema = z.object({
  password: z.string().min(1),
  code: z.string().trim().min(6).max(32),
});
