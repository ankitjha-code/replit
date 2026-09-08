import { ApiError } from '../../lib/api-client.js';

/**
 * What autosave does about a failed write.
 *
 * The overriding rule is that source code is never lost silently. Every branch
 * below either keeps retrying, or stops and says so in a way the person can
 * act on. Nothing discards a buffer.
 */

export type FailureResponse =
  /** Transient. Try again after a delay; the text stays in the buffer. */
  | 'retry'
  /** Someone else wrote to this file. Needs a decision, so autosave stops. */
  | 'conflict'
  /** Retrying cannot help. Stop, and show why. */
  | 'blocked';

/**
 * Classifies a failed save.
 *
 * The distinction that matters is whether trying again could succeed. A
 * network drop or a restarting server will heal on its own; a file too large,
 * a revoked permission or a rejected path will not, and retrying them forever
 * would hide the real problem behind a spinner.
 */
export function classifyFailure(error: unknown): FailureResponse {
  if (!(error instanceof ApiError)) {
    // An unrecognised failure is treated as transient. Retrying costs a
    // request; giving up could cost someone's work.
    return 'retry';
  }

  switch (error.code) {
    case 'CONFLICT':
      return 'conflict';

    // The connection failed, or the server is unreachable or restarting.
    case 'SERVICE_UNAVAILABLE':
    case 'INTERNAL_ERROR':
    case 'EXECUTION_FAILED':
    case 'STORAGE_FAILED':
      return 'retry';

    // Rate limiting passes: the limit lifts, and the retry delay grows.
    case 'RATE_LIMITED':
      return 'retry';

    // The request itself is wrong, or no longer permitted. Trying again with
    // the same content produces the same answer.
    default:
      return 'blocked';
  }
}

export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 30_000;

/**
 * How long to wait before attempt number `attempt` (1-based).
 *
 * Exponential with a ceiling. The ceiling matters more than the growth: a
 * person who leaves a tab open through a long outage should still get their
 * work saved within half a minute of the server returning, not hours later.
 */
export function retryDelay(attempt: number): number {
  const exponential = RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(RETRY_MAX_MS, exponential);
}

/** Quiet period after the last keystroke before a save is attempted. */
export const DEBOUNCE_MS = 800;

/**
 * Longest a buffer may stay unsaved while someone is still typing.
 *
 * Without this, continuous typing defers the save indefinitely and a crash
 * loses everything since the file was opened.
 */
export const MAX_WAIT_MS = 5_000;
