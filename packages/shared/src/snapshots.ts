import { z } from 'zod';

export const SNAPSHOT_KINDS = ['MANUAL', 'AUTOMATIC', 'DEPLOYMENT'] as const;

export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];

export const MAX_SNAPSHOT_NAME_LENGTH = 100;
export const MAX_SNAPSHOT_DESCRIPTION_LENGTH = 500;

export const snapshotNameSchema = z
  .string()
  .trim()
  .min(1, 'Give the snapshot a name')
  .max(MAX_SNAPSHOT_NAME_LENGTH)
  .refine((name) => !name.includes('\0'), 'A name cannot contain a null byte');

export const snapshotDescriptionSchema = z
  .string()
  .trim()
  .max(MAX_SNAPSHOT_DESCRIPTION_LENGTH)
  .refine((text) => !text.includes('\0'), 'A description cannot contain a null byte');

export const createSnapshotRequestSchema = z.object({
  name: snapshotNameSchema,
  description: snapshotDescriptionSchema.optional(),
});

export type CreateSnapshotRequest = z.infer<typeof createSnapshotRequestSchema>;

export const snapshotSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  kind: z.enum(SNAPSHOT_KINDS),
  fileCount: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  checksum: z.string(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});

export type SnapshotSummary = z.infer<typeof snapshotSummarySchema>;

export const snapshotListResponseSchema = z.object({
  snapshots: z.array(snapshotSummarySchema),
  limit: z.number().int().positive(),
  unavailableReason: z.string().nullable(),
});

export type SnapshotListResponse = z.infer<typeof snapshotListResponseSchema>;
