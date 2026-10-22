import { z } from 'zod';
import { passwordSchema } from './auth.js';

export const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: passwordSchema,
    signOutOthers: z.boolean().default(true),
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: 'That is the password you are already using',
    path: ['newPassword'],
  });

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const changePasswordResponseSchema = z.object({
  signedOut: z.number().int().min(0),
});

export type ChangePasswordResponse = z.infer<typeof changePasswordResponseSchema>;

export const accountSessionSchema = z.object({
  id: z.string(),
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

export const deleteAccountRequestSchema = z.object({
  password: z.string().min(1, 'Enter your password'),
  confirmUsername: z.string().min(1),
});

export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;

export const deleteAccountResponseSchema = z.object({
  projectsDeleted: z.number().int().min(0),
});

export type DeleteAccountResponse = z.infer<typeof deleteAccountResponseSchema>;
