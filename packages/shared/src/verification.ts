import { z } from 'zod';
import { emailSchema, passwordSchema } from './auth.js';

/**
 * Proving an address, and getting back in without a password.
 *
 * Two flows that look alike and are not. Verification proves that whoever holds
 * the account also reads the address on it. A reset *changes the credential*,
 * which means a link in an inbox is temporarily as powerful as the password —
 * so the two differ everywhere it matters: how long a link lasts, what it does
 * to existing sessions, and how the request is answered.
 */

// ---------------------------------------------------------------------------
// Verifying an address
// ---------------------------------------------------------------------------

/** No body: the account is the one making the request. */
export const verificationStatusSchema = z.object({
  email: z.string(),
  verified: z.boolean(),
  /**
   * Whether asking is even possible here.
   *
   * An installation with no mail server must say so rather than offering a
   * button that fails. The page then explains instead of inviting a click.
   */
  canSend: z.boolean(),
  /** Why not, when it cannot. Written to be shown. */
  reason: z.string().nullable(),
});

export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

export const confirmTokenRequestSchema = z.object({
  token: z.string().min(1, 'That link is missing its code'),
});

export type ConfirmTokenRequest = z.infer<typeof confirmTokenRequestSchema>;

// ---------------------------------------------------------------------------
// Resetting a forgotten password
// ---------------------------------------------------------------------------

export const passwordResetRequestSchema = z.object({
  email: emailSchema,
});

export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;

/**
 * The answer to "send me a reset link", which is always the same.
 *
 * Deliberately says nothing about whether the address has an account. An
 * endpoint that answered differently would be a way to test whether somebody is
 * a user here, which is a fact worth having about a person: it is a list of who
 * to phish, and for some installations it is a list of who works somewhere.
 *
 * This costs a real thing — somebody who mistypes their address is told the
 * same thing as somebody who did not — and the message that arrives is what
 * distinguishes them. That is the trade every service makes here, and it is the
 * right way round.
 */
export const passwordResetResponseSchema = z.object({
  /** Always true. Present so the client has something to key a message off. */
  accepted: z.literal(true),
});

export type PasswordResetResponse = z.infer<typeof passwordResetResponseSchema>;

export const passwordResetCompleteSchema = z.object({
  token: z.string().min(1, 'That link is missing its code'),
  password: passwordSchema,
});

export type PasswordResetComplete = z.infer<typeof passwordResetCompleteSchema>;
