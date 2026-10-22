import { ApiError } from '../../lib/api-client.js';

export type FailureResponse = 'retry' | 'conflict' | 'blocked';

export function classifyFailure(error: unknown): FailureResponse {
  if (!(error instanceof ApiError)) {
    return 'retry';
  }

  switch (error.code) {
    case 'CONFLICT':
      return 'conflict';

    case 'SERVICE_UNAVAILABLE':
    case 'INTERNAL_ERROR':
    case 'EXECUTION_FAILED':
    case 'STORAGE_FAILED':
      return 'retry';

    case 'RATE_LIMITED':
      return 'retry';

    default:
      return 'blocked';
  }
}

export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 30_000;

export function retryDelay(attempt: number): number {
  const exponential = RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(RETRY_MAX_MS, exponential);
}

export const DEBOUNCE_MS = 800;

export const MAX_WAIT_MS = 5_000;
