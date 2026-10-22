import { z } from 'zod';
import { emailSchema, passwordSchema } from './auth.js';

export const verificationStatusSchema = z.object({
  email: z.string(),
  verified: z.boolean(),
  canSend: z.boolean(),
  reason: z.string().nullable(),
});

export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

export const confirmTokenRequestSchema = z.object({
  token: z.string().min(1, 'That link is missing its code'),
});

export type ConfirmTokenRequest = z.infer<typeof confirmTokenRequestSchema>;

export const passwordResetRequestSchema = z.object({
  email: emailSchema,
});

export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;

export const passwordResetResponseSchema = z.object({
  accepted: z.literal(true),
});

export type PasswordResetResponse = z.infer<typeof passwordResetResponseSchema>;

export const passwordResetCompleteSchema = z.object({
  token: z.string().min(1, 'That link is missing its code'),
  password: passwordSchema,
});

export type PasswordResetComplete = z.infer<typeof passwordResetCompleteSchema>;
