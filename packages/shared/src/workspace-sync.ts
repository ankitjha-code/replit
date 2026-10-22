import { z } from 'zod';

/**
 * Bringing a container's workspace back into the database.
 *
 * A runtime starts as a copy of the project. Then a command runs in it: a
 * dependency install, a generator, a formatter, a build. Those changes exist
 * only inside the container, and the container is not storage. Reading them
 * back is what makes the database the source of truth in fact rather than in
 * intention.
 *
 * The direction matters. Files flow into a container when it starts and back
 * out when someone asks, or when it stops. Nothing merges: what the container
 * holds replaces what the database holds for the paths it covers, because the
 * container is where the work just happened.
 */

/**
 * Directories that never come back.
 *
 * Every one of these is either derived from something already stored, or
 * belongs to a tool rather than to the project. `node_modules` alone is
 * routinely a hundred thousand files, and putting it in a database would
 * exceed every limit the project has while storing nothing anyone wrote.
 *
 * Matched on any path segment, not only at the root: a workspace with several
 * packages in it has one of these inside each.
 */
export const SYNC_EXCLUDED_DIRECTORIES = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.pnpm-store',
  '.yarn',
  'venv',
  '.venv',
  'env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'vendor',
  'target',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.gradle',
  '.terraform',
  'coverage',
] as const;

/**
 * Files that never come back, matched on the final segment.
 *
 * Sockets and lock files belong to a running process. A file whose name starts
 * with a dot is otherwise kept: `.env.example`, `.gitignore` and `.nvmrc` are
 * all part of a project.
 */
export const SYNC_EXCLUDED_FILES = ['.DS_Store', 'Thumbs.db'] as const;

const excludedDirectories = new Set<string>(SYNC_EXCLUDED_DIRECTORIES);
const excludedFiles = new Set<string>(SYNC_EXCLUDED_FILES);

/**
 * Whether a path is left in the container.
 *
 * Deliberately a decision about the whole path rather than about its last
 * segment: everything beneath an excluded directory is excluded with it, and
 * checking each file against its ancestors is the only way to say so.
 */
export function isExcludedFromSync(path: string): boolean {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return true;

  for (const segment of segments.slice(0, -1)) {
    if (excludedDirectories.has(segment)) return true;
  }

  const last = segments[segments.length - 1]!;
  return excludedDirectories.has(last) || excludedFiles.has(last);
}

/** Why one path was left behind, in words that name the fix. */
export const SYNC_SKIP_REASONS = [
  'excluded',
  'too-large',
  'invalid-path',
  'quota',
  /**
   * The runtime reported nothing at all while the project has files.
   *
   * Treated as a read that went wrong rather than as a deletion of everything.
   * The cost of being wrong one way is a sync that did nothing; the other way
   * it is the whole project.
   */
  'empty-read',
] as const;

export type SyncSkipReason = (typeof SYNC_SKIP_REASONS)[number];

export const syncSkipSchema = z.object({
  path: z.string(),
  reason: z.enum(SYNC_SKIP_REASONS),
});

export const workspaceSyncResultSchema = z.object({
  /** Paths that were not in the project before. */
  created: z.number().int().nonnegative(),
  /** Paths whose content differs from what was stored. */
  updated: z.number().int().nonnegative(),
  /** Paths the container no longer has. */
  deleted: z.number().int().nonnegative(),
  /** Paths that were already identical. Counted, because "nothing changed" is an answer. */
  unchanged: z.number().int().nonnegative(),
  /**
   * What was left behind and why.
   *
   * Bounded, because a container with a build directory in it can produce
   * thousands and a person needs the first few, not all of them.
   */
  skipped: z.array(syncSkipSchema),
  /** True when more was skipped than is listed. */
  skippedTruncated: z.boolean(),
});

export type WorkspaceSyncResult = z.infer<typeof workspaceSyncResultSchema>;

/** How many skipped paths are worth reporting. */
export const MAX_REPORTED_SKIPS = 20;
