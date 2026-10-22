import { z } from 'zod';
import { isReservedSecretKey, MAX_SECRET_KEY_LENGTH, SECRET_KEY_PATTERN } from './secrets.js';

export const VARIABLE_KEY_PATTERN = SECRET_KEY_PATTERN;
export const MAX_VARIABLE_KEY_LENGTH = MAX_SECRET_KEY_LENGTH;

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

export const variableValueSchema = z
  .string()
  .max(MAX_VARIABLE_VALUE_LENGTH)
  .refine((value) => !value.includes('\0'), 'A value cannot contain a null byte');

export const setVariableRequestSchema = z.object({
  key: variableKeySchema,
  value: variableValueSchema,
});

export type SetVariableRequest = z.infer<typeof setVariableRequestSchema>;

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
  restartRequired: z.boolean(),
});

export type VariableListResponse = z.infer<typeof variableListResponseSchema>;
