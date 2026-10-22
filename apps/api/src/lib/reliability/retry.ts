export interface RetryOptions {
  attempts: number;
  baseMs: number;
  maxMs: number;
  isTransient: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export async function withRetry<T>(work: () => Promise<T>, options: RetryOptions): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;

      const isLast = attempt === options.attempts;
      if (isLast || !options.isTransient(error)) throw error;

      const delay = backoff(attempt, options);
      options.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }

  throw lastError;
}

function backoff(attempt: number, options: RetryOptions): number {
  const ceiling = Math.min(options.baseMs * 2 ** (attempt - 1), options.maxMs);

  return Math.round(Math.random() * ceiling);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

export function isTransientNetworkError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const candidate = error as { code?: unknown; statusCode?: unknown; name?: unknown };

  if (typeof candidate.code === 'string' && TRANSIENT_CODES.has(candidate.code)) return true;

  if (typeof candidate.statusCode === 'number') {
    return (
      candidate.statusCode === 502 || candidate.statusCode === 503 || candidate.statusCode === 504
    );
  }

  return candidate.name === 'AbortError';
}
