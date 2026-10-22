import { z } from 'zod';
import { isReservedSecretKey, MAX_SECRET_KEY_LENGTH, SECRET_KEY_PATTERN } from './secrets.js';

/**
 * Project environment variables: configuration that is not a secret.
 *
 * The counterpart to secrets, and deliberately their opposite. A secret's whole
 * design is that the value goes in and never comes out, which is right for a
 * credential and wrong for a port number, a feature flag or a log level.
 * Somebody who cannot read back what they set cannot check it, cannot correct a
 * typo in it, and cannot hand the project to anyone else.
 *
 * So a variable is readable by anyone who may edit the project, and is shown
 * plainly. That is the entire difference, and it is why the two are separate
 * things rather than one thing with a flag: a flag would mean an interface
 * where the sensitive case is a checkbox somebody can forget to tick.
 *
 * The naming rules are shared with secrets, because both end up in the same
 * environment and a name is legal or not regardless of which side set it.
 */

export const VARIABLE_KEY_PATTERN = SECRET_KEY_PATTERN;
export const MAX_VARIABLE_KEY_LENGTH = MAX_SECRET_KEY_LENGTH;

/**
 * Bounded because every one of these is passed to a container at start.
 *
 * Smaller than a secret's ceiling: a secret may be a certificate or a private
 * key, whereas configuration that a person reads on a page is not.
 */
export const MAX_VARIABLE_VALUE_LENGTH = 4 * 1024;

export const variableKeySchema = z
  .string()
  .trim()
  .min(1, 'Give the variable a name')
  .max(MAX_VARIABLE_KEY_LENGTH)
  .refine(
    (key) => VARIABLE_KEY_PATTERN.test(key),
    'Use capital letters, digits and underscores, starting with a letter or an underscore',
  )
  .refine((key) => !isReservedSecretKey(key), 'That name is reserved by the platform');

/**
 * Values may be empty, which is the one place variables and secrets differ in
 * what they accept.
 *
 * An empty secret is a mistake: nobody means to store a credential of no
 * length. An empty environment variable is ordinary and means something
 * specific to most programs, which distinguish a variable set to nothing from
 * one that is not set at all.
 *
 * A NUL byte cannot survive the boundary between a process and its
 * environment, so it is refused here rather than being silently truncated in
 * the container.
 */
export const variableValueSchema = z
  .string()
  .max(MAX_VARIABLE_VALUE_LENGTH)
  .refine((value) => !value.includes('\0'), 'A value cannot contain a null byte');

export const setVariableRequestSchema = z.object({
  key: variableKeySchema,
  value: variableValueSchema,
});

export type SetVariableRequest = z.infer<typeof setVariableRequestSchema>;

/** A variable, value and all. The value is the point. */
export const variableSchema = z.object({
  key: z.string(),
  value: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProjectVariable = z.infer<typeof variableSchema>;

export const variableListResponseSchema = z.object({
  variables: z.array(variableSchema),
  limit: z.number().int().positive(),
  /**
   * Whether the project is running with something other than what is listed.
   *
   * A container is given its environment when it is created, so editing a
   * variable changes what the next start will use and not what is running now.
   * Saying so is the difference between a person restarting the project and a
   * person spending an afternoon wondering why their change did nothing.
   */
  restartRequired: z.boolean(),
});

export type VariableListResponse = z.infer<typeof variableListResponseSchema>;
