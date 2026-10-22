import { z } from 'zod';
import { snapshotSummarySchema } from './snapshots.js';

export const RESTORE_SOURCES = ['snapshot', 'commit'] as const;

export type RestoreSource = (typeof RESTORE_SOURCES)[number];

export const restoreResultSchema = z.object({
  source: z.enum(RESTORE_SOURCES),
  reference: z.string(),
  label: z.string(),

  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),

  safetySnapshot: snapshotSummarySchema.nullable(),

  restartRequired: z.boolean(),
});

export type RestoreResult = z.infer<typeof restoreResultSchema>;

export const restoreResponseSchema = z.object({ restore: restoreResultSchema });

export type RestoreResponse = z.infer<typeof restoreResponseSchema>;

export const restoreFileRequestSchema = z.object({
  path: z.string().min(1).max(1024),
});

export type RestoreFileRequest = z.infer<typeof restoreFileRequestSchema>;

export const restoreFileResponseSchema = z.object({
  path: z.string(),
  previous: z.object({ content: z.string(), encoding: z.enum(['utf8', 'base64']) }).nullable(),
});

export type RestoreFileResponse = z.infer<typeof restoreFileResponseSchema>;
