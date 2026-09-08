import { z } from 'zod';
import { snapshotSummarySchema } from './snapshots.js';

/**
 * Putting a project back to how it was.
 *
 * Snapshots and history record what a project said; this is the half that
 * makes those records useful. Without it a snapshot is only a download, and a
 * commit is only something to read.
 *
 * A restore replaces the project's files outright. Nothing is merged: a merge
 * needs a common ancestor, and between "the files as they are now" and "the
 * files as they were in March" there is no meaningful one. So the operation is
 * destructive by design, and everything below exists to make that survivable.
 */

/** Where the files being restored came from. */
export const RESTORE_SOURCES = ['snapshot', 'commit'] as const;

export type RestoreSource = (typeof RESTORE_SOURCES)[number];

export const restoreResultSchema = z.object({
  source: z.enum(RESTORE_SOURCES),
  /** The snapshot's identifier, or the commit's object id. */
  reference: z.string(),
  /** What to call it on screen: a snapshot's name, or a commit's subject. */
  label: z.string(),

  /** Files that did not exist in the project before this. */
  created: z.number().int().nonnegative(),
  /** Files that existed and now hold different content. */
  updated: z.number().int().nonnegative(),
  /** Files the project had and the restored version does not. */
  deleted: z.number().int().nonnegative(),
  /** Files that were already identical. Counted so a no-op reads as one. */
  unchanged: z.number().int().nonnegative(),

  /**
   * The snapshot taken of what was there immediately before, so this can be
   * undone.
   *
   * Never null in practice on an installation with object storage, because a
   * restore is refused when one cannot be taken. It is nullable because the
   * shape has to be able to say so rather than imply a safety net that is not
   * there.
   */
  safetySnapshot: snapshotSummarySchema.nullable(),

  /**
   * True when a container is running with the old files still inside it.
   *
   * Cannot happen today, because a restore is refused while anything is
   * running. Carried so that the day the refusal is relaxed, the client is
   * already saying the true thing.
   */
  restartRequired: z.boolean(),
});

export type RestoreResult = z.infer<typeof restoreResultSchema>;

export const restoreResponseSchema = z.object({ restore: restoreResultSchema });

export type RestoreResponse = z.infer<typeof restoreResponseSchema>;

/**
 * Putting one file back, from a snapshot or a commit.
 *
 * Unlike a whole-project restore, this works while the project is running: it
 * is an edit whose content happens to come from history, and editing a running
 * project is ordinary. And unlike a whole-project restore, it takes no snapshot
 * first — one file does not justify copying the whole project — so the answer
 * carries what the file held before, and the page offers to put that back.
 */
export const restoreFileRequestSchema = z.object({
  path: z.string().min(1).max(1024),
});

export type RestoreFileRequest = z.infer<typeof restoreFileRequestSchema>;

export const restoreFileResponseSchema = z.object({
  path: z.string(),
  /**
   * What the file held a moment ago, so the change can be undone at once.
   * Null when the file did not exist before the restore.
   */
  previous: z.object({ content: z.string(), encoding: z.enum(['utf8', 'base64']) }).nullable(),
});

export type RestoreFileResponse = z.infer<typeof restoreFileResponseSchema>;
