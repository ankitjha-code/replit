/**
 * Trying again, for the failures where trying again is the right answer.
 *
 * The platform talks to five things it does not control: a container runtime, an
 * object store, a database server for projects, DNS, and a queue. All five fail
 * in two very different ways, and the whole value of this file is refusing to
 * treat them the same:
 *
 *  - **Transient.** A connection reset, a timeout, a moment of unavailability.
 *    The same call a second later succeeds. Not retrying turns a blip into a
 *    failed deployment.
 *  - **Permanent.** A missing object, a refused credential, a malformed
 *    request. The same call a second later fails identically. Retrying wastes
 *    time, and worse, it can multiply a side effect that did happen.
 *
 * There is no general way to tell them apart, which is why the caller supplies
 * the judgement. A default that guessed would be wrong in the direction that
 * costs the most: retrying something that already happened.
 */

export interface RetryOptions {
  /** How many times to try in total, including the first. */
  attempts: number;
  /** The first delay. Each further one doubles, to the ceiling below. */
  baseMs: number;
  maxMs: number;
  /**
   * Whether this failure is worth trying again.
   *
   * Required rather than defaulted. A default would have to guess, and guessing
   * wrong in the permissive direction means repeating an operation that already
   * had an effect.
   */
  isTransient: (error: unknown) => boolean;
  /** Told before each wait, so a caller can log what is being retried. */
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

  // Unreachable: the loop either returns or throws. Present because a function
  // that can fall off the end is one TypeScript has to be told about, and an
  // explicit throw is better than a cast.
  throw lastError;
}

/**
 * How long to wait, doubling, with jitter.
 *
 * The jitter is the part that is easy to leave out and expensive to. Without it
 * every caller that failed at the same moment — which is what a dependency
 * going down means — retries at the same moment, and the dependency coming back
 * is met with the entire backlog at once. Spreading them out over the interval
 * is the difference between a recovery and a second outage.
 */
function backoff(attempt: number, options: RetryOptions): number {
  const ceiling = Math.min(options.baseMs * 2 ** (attempt - 1), options.maxMs);

  // Full jitter: anywhere in [0, ceiling). Better than a small random addition,
  // which still leaves everybody clustered around the same point.
  return Math.round(Math.random() * ceiling);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Failures that are worth trying again, as far as a network client can tell.
 *
 * Deliberately conservative: this says yes only to things that are plainly about
 * reaching something, and no to everything it does not recognise. A predicate
 * that guessed generously would retry a refused credential four times and a
 * duplicate write four times, and the second of those is how a retry becomes a
 * bug rather than a mitigation.
 */
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

  /*
   * The server said it could not cope, which is a statement about now.
   *
   * 500 is not on this list on purpose: it means something went wrong, and
   * what went wrong may well be the request itself. 502, 503 and 504 are all
   * about reaching something, which is exactly the case retrying is for.
   */
  if (typeof candidate.statusCode === 'number') {
    return (
      candidate.statusCode === 502 || candidate.statusCode === 503 || candidate.statusCode === 504
    );
  }

  return candidate.name === 'AbortError';
}
