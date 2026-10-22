import { z } from 'zod';

/**
 * Project snapshots: a named, frozen copy of every source file in a project.
 *
 * The point is to be able to go back. Editing is continuous and autosaving, so
 * there is no moment at which a project is "as it was an hour ago" unless
 * somebody wrote one down. A snapshot is that moment, kept whole.
 *
 * Immutable once taken. A snapshot that could be edited is not a record of
 * anything, and the one thing anybody needs from it is confidence that it says
 * what the project actually said at the time.
 *
 * Restoring one puts every file in the project back to what the archive holds.
 * That is destructive, so the platform takes one of its own first: see
 * `SNAPSHOT_KINDS` below and `restore.ts` for the shape of the result.
 */

/**
 * Who asked for a snapshot.
 *
 * A manual one is a decision somebody made and is kept until they remove it.
 * An automatic one is taken by the platform immediately before a restore, so
 * that a restore can be undone; those are pruned oldest-first and are not
 * counted against what a person is allowed to keep, because nobody should lose
 * the ability to go back on the grounds that they went back too often.
 *
 * A deployment one is the fixed version a deployment was built from. It is
 * never pruned and never counted, because it is not a convenience: it is the
 * answer to "what is actually running", and it lives and dies with the
 * deployment that points at it.
 */
export const SNAPSHOT_KINDS = ['MANUAL', 'AUTOMATIC', 'DEPLOYMENT'] as const;

export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];

export const MAX_SNAPSHOT_NAME_LENGTH = 100;
export const MAX_SNAPSHOT_DESCRIPTION_LENGTH = 500;

export const snapshotNameSchema = z
  .string()
  .trim()
  .min(1, 'Give the snapshot a name')
  .max(MAX_SNAPSHOT_NAME_LENGTH)
  /*
   * A name is shown and nothing more.
   *
   * It never becomes a storage key, a path or a filename: those are generated.
   * So the only rules are the ones that keep it displayable.
   */
  .refine((name) => !name.includes('\0'), 'A name cannot contain a null byte');

export const snapshotDescriptionSchema = z
  .string()
  .trim()
  .max(MAX_SNAPSHOT_DESCRIPTION_LENGTH)
  .refine((text) => !text.includes('\0'), 'A description cannot contain a null byte');

export const createSnapshotRequestSchema = z.object({
  name: snapshotNameSchema,
  /** Why this moment was worth keeping. Optional, because often it is obvious. */
  description: snapshotDescriptionSchema.optional(),
});

export type CreateSnapshotRequest = z.infer<typeof createSnapshotRequestSchema>;

export const snapshotSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  kind: z.enum(SNAPSHOT_KINDS),
  /** How many files it holds, directories included. */
  fileCount: z.number().int().nonnegative(),
  /** The size of the stored archive, not of the project it came from. */
  sizeBytes: z.number().int().nonnegative(),
  /**
   * SHA-256 of the archive as it was stored.
   *
   * Kept so that what comes back can be checked against what went in. A
   * truncated or altered archive is then a refusal rather than a restore that
   * quietly loses half a project.
   */
  checksum: z.string(),
  createdAt: z.string(),
  /** Null when the account that took it has since been removed. */
  createdBy: z.string().nullable(),
});

export type SnapshotSummary = z.infer<typeof snapshotSummarySchema>;

export const snapshotListResponseSchema = z.object({
  snapshots: z.array(snapshotSummarySchema),
  /** How many one project may keep. Automatic snapshots do not count. */
  limit: z.number().int().positive(),
  /**
   * Why snapshots cannot be taken here, or null when they can.
   *
   * Taking one needs somewhere to put it, and an installation with no object
   * store says so rather than offering a button that records a row describing
   * an archive that does not exist.
   */
  unavailableReason: z.string().nullable(),
});

export type SnapshotListResponse = z.infer<typeof snapshotListResponseSchema>;
