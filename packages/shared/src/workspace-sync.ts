import { z } from 'zod';

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

export const SYNC_EXCLUDED_FILES = ['.DS_Store', 'Thumbs.db'] as const;

const excludedDirectories = new Set<string>(SYNC_EXCLUDED_DIRECTORIES);
const excludedFiles = new Set<string>(SYNC_EXCLUDED_FILES);

export function isExcludedFromSync(path: string): boolean {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return true;

  for (const segment of segments.slice(0, -1)) {
    if (excludedDirectories.has(segment)) return true;
  }

  const last = segments[segments.length - 1]!;
  return excludedDirectories.has(last) || excludedFiles.has(last);
}

export const SYNC_SKIP_REASONS = [
  'excluded',
  'too-large',
  'invalid-path',
  'quota',
  'empty-read',
] as const;

export type SyncSkipReason = (typeof SYNC_SKIP_REASONS)[number];

export const syncSkipSchema = z.object({
  path: z.string(),
  reason: z.enum(SYNC_SKIP_REASONS),
});

export const workspaceSyncResultSchema = z.object({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  skipped: z.array(syncSkipSchema),
  skippedTruncated: z.boolean(),
});

export type WorkspaceSyncResult = z.infer<typeof workspaceSyncResultSchema>;

export const MAX_REPORTED_SKIPS = 20;
