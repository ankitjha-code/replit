import { z } from 'zod';
import { authenticatedResponseSchema } from './auth.js';

export const loginResponseSchema = z.union([
  authenticatedResponseSchema,
  z.object({
    twoFactorRequired: z.literal(true),
    challenge: z.string(),
  }),
]);

export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const twoFactorLoginRequestSchema = z.object({
  challenge: z.string().min(1),
  code: z.string().trim().min(6).max(32),
});

export type TwoFactorLoginRequest = z.infer<typeof twoFactorLoginRequestSchema>;

export const twoFactorStatusSchema = z.object({
  enabled: z.boolean(),
  recoveryCodesLeft: z.number().int().min(0),
  available: z.boolean(),
});

export type TwoFactorStatus = z.infer<typeof twoFactorStatusSchema>;

export const twoFactorSetupResponseSchema = z.object({
  secret: z.string(),
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
  recoveryCodes: z.array(z.string()),
});

export type TwoFactorConfirmResponse = z.infer<typeof twoFactorConfirmResponseSchema>;

export const twoFactorDisableRequestSchema = z.object({
  password: z.string().min(1),
  code: z.string().trim().min(6).max(32),
});
