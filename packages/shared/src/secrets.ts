import { z } from 'zod';

/**
 * Project secrets: environment variables a project needs and nobody should be
 * able to read back.
 *
 * The whole design follows from one rule: a value goes in and never comes out.
 * It is encrypted before it is stored, it is never returned by any endpoint,
 * it is never logged, and the only place it is decrypted is on its way into a
 * container. Someone who forgets a value sets it again; that is a far better
 * outcome than an interface that can be used to read every credential a
 * project has.
 */

/**
 * What a name may be.
 *
 * The shape a shell requires of an environment variable, which is also what
 * every language's own reader expects. Enforced here rather than left to the
 * container, where a malformed name is silently dropped and the project fails
 * later for no visible reason.
 */
export const SECRET_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export const MAX_SECRET_KEY_LENGTH = 128;

/**
 * Values are bounded, because they are held in memory while being encrypted
 * and are passed to a container as an argument.
 */
export const MAX_SECRET_VALUE_LENGTH = 16 * 1024;

/**
 * Names the platform will not set.
 *
 * These change how a process finds and loads code, and setting one turns an
 * unrelated failure inside the container into something nobody can diagnose.
 * The container is isolated either way, so this is about a runtime that
 * behaves predictably rather than about protecting the platform from the
 * project.
 */
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

/**
 * What a caller learns about a secret.
 *
 * The name, when it changed, and how long the value is. No value, no prefix,
 * no last four characters. A hint is a way to confirm a guess, and the length
 * is already visible to anyone who can set one.
 */
export const secretSummarySchema = z.object({
  key: z.string(),
  /** Characters, so an interface can show a plausible number of dots. */
  length: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SecretSummary = z.infer<typeof secretSummarySchema>;

export const secretListResponseSchema = z.object({
  secrets: z.array(secretSummarySchema),
  /**
   * Why secrets cannot be used, or null when they can.
   *
   * Storing them needs an encryption key the installation may not have, and an
   * interface that offered to store one it could not encrypt would be worse
   * than one that says so.
   */
  unavailableReason: z.string().nullable(),
  limit: z.number().int().positive(),
});

export type SecretListResponse = z.infer<typeof secretListResponseSchema>;
