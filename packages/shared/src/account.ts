import { z } from 'zod';
import { passwordSchema } from './auth.js';

/**
 * Managing the account you are signed in to.
 *
 * Three things, and what unites them is that each is an answer to "somebody
 * else may have my password":
 *
 *  - **Change it**, which is the fix.
 *  - **See where you are signed in**, which is how you find out.
 *  - **Sign those places out**, which is what makes changing it mean anything.
 *
 * What is deliberately not here is a password *reset* — the one you use when
 * you cannot sign in. That needs a message sent to an address, which needs a
 * mail service this installation does not have. Half of it, a token table with
 * no way to deliver a token, would be worse than none.
 */

// ---------------------------------------------------------------------------
// Changing a password
// ---------------------------------------------------------------------------

export const changePasswordRequestSchema = z
  .object({
    /**
     * Proof that whoever is asking is the account holder and not a borrowed
     * browser. The session already says who they are; it does not say that.
     */
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: passwordSchema,
    /**
     * Whether every other session ends.
     *
     * Offered rather than forced, and defaulting to yes. Somebody changing a
     * password because it may be known wants every other browser signed out;
     * somebody changing it as housekeeping may have a phone they would rather
     * not have to sign in on again. Only the person knows which they are.
     */
    signOutOthers: z.boolean().default(true),
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: 'That is the password you are already using',
    path: ['newPassword'],
  });

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const changePasswordResponseSchema = z.object({
  /** How many other sessions were ended, so the page can say so plainly. */
  signedOut: z.number().int().min(0),
});

export type ChangePasswordResponse = z.infer<typeof changePasswordResponseSchema>;

// ---------------------------------------------------------------------------
// Where you are signed in
// ---------------------------------------------------------------------------

/**
 * One session, as its owner may see it.
 *
 * Named for the account rather than for the session, because `auth.ts` already
 * has a session summary meaning something else entirely — the one fact a
 * sign-in response carries about the session it just issued. Two different
 * things called the same name is how somebody eventually returns the wrong
 * one.
 *
 * No token and no hash. The row's whole purpose is to hold a credential, and
 * the shape that leaves the server must have nowhere to put one — the same
 * reason `PublicUser` has no field for a password hash.
 *
 * The address is included because it is the field that makes a strange session
 * recognisable as strange, and the person looking at it is the one it is about.
 */
export const accountSessionSchema = z.object({
  id: z.string(),
  /** True for the session making the request, so a page can label it. */
  current: z.boolean(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
});

export type AccountSession = z.infer<typeof accountSessionSchema>;

export const sessionListResponseSchema = z.object({
  sessions: z.array(accountSessionSchema),
});

export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

export const revokeSessionsResponseSchema = z.object({
  signedOut: z.number().int().min(0),
});

export type RevokeSessionsResponse = z.infer<typeof revokeSessionsResponseSchema>;

// ---------------------------------------------------------------------------
// Closing an account
// ---------------------------------------------------------------------------

/**
 * Deleting an account, which deletes everything in it.
 *
 * Two confirmations, and they are not the same confirmation twice. The password
 * proves it is the account holder. The typed username proves they meant this
 * account rather than clicked the button — the second is the one that catches a
 * person who is tired, and it is the only protection against a mistake that
 * nothing can undo.
 */
export const deleteAccountRequestSchema = z.object({
  password: z.string().min(1, 'Enter your password'),
  /** Must equal the account's own username. Checked on the server. */
  confirmUsername: z.string().min(1),
});

export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;

export const deleteAccountResponseSchema = z.object({
  /** What went with it, so the goodbye is specific rather than vague. */
  projectsDeleted: z.number().int().min(0),
});

export type DeleteAccountResponse = z.infer<typeof deleteAccountResponseSchema>;
