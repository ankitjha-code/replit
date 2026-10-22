import { z } from 'zod';

export const SECRET_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export const MAX_SECRET_KEY_LENGTH = 128;

export const MAX_SECRET_VALUE_LENGTH = 16 * 1024;

export const RESERVED_SECRET_KEYS = [
  'PATH',
  'HOME',
  'IFS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'BASH_ENV',
  'ENV',
  'SHELL',
  'PWD',
] as const;

const reserved = new Set<string>(RESERVED_SECRET_KEYS);

export function isReservedSecretKey(key: string): boolean {
  return reserved.has(key.toUpperCase());
}

export const secretKeySchema = z
  .string()
  .trim()
  .min(1, 'Give the value a name')
  .max(MAX_SECRET_KEY_LENGTH)
  .refine(
    (key) => SECRET_KEY_PATTERN.test(key),
    'Use capital letters, digits and underscores, starting with a letter or an underscore',
  )
  .refine((key) => !isReservedSecretKey(key), 'That name is reserved by the platform');

export const secretValueSchema = z
  .string()
  .min(1, 'Give the value something to store')
  .max(MAX_SECRET_VALUE_LENGTH);

export const setSecretRequestSchema = z.object({
  key: secretKeySchema,
  value: secretValueSchema,
});

export type SetSecretRequest = z.infer<typeof setSecretRequestSchema>;

export const secretSummarySchema = z.object({
  key: z.string(),
  length: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SecretSummary = z.infer<typeof secretSummarySchema>;

export const secretListResponseSchema = z.object({
  secrets: z.array(secretSummarySchema),
  unavailableReason: z.string().nullable(),
  limit: z.number().int().positive(),
});

export type SecretListResponse = z.infer<typeof secretListResponseSchema>;
