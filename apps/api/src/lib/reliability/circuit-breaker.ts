import type { Logger } from 'pino';

/**
 * Failing fast while something is known to be down.
 *
 * Retrying handles a blip. It makes a sustained outage worse: every request
 * waits out its attempts and its backoff before failing, so a dependency being
 * down turns into a control plane where every request is slow, connections pile
 * up, and the platform becomes unavailable for things that have nothing to do
 * with the dependency that failed.
 *
 * A breaker is the answer to that. Once enough calls in a row have failed, it
 * stops making them and refuses immediately, which keeps the failure contained
 * to the feature that needs the dependency instead of spreading it to the whole
 * process.
 *
 * ## Three states, and the middle one is the point
 *
 * - **Closed.** Calls go through. Failures are counted; a success resets the
 *   count, because what matters is a run of failures rather than a total.
 * - **Open.** Calls are refused without being attempted. This is the state that
 *   protects the platform.
 * - **Half open.** After a cooling-off period, exactly **one** call is allowed
 *   through to find out. It succeeds and the breaker closes; it fails and the
 *   breaker opens again.
 *
 * The half-open state is what makes this a breaker rather than a switch. Without
 * it, recovery needs either somebody to notice, or a flood of traffic at the
 * moment the dependency comes back — which is what knocked it over.
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** What this protects, for logs and for the health page. */
  name: string;
  /** Consecutive failures before it opens. */
  threshold: number;
  /** How long it stays open before letting one call through. */
  resetAfterMs: number;
  log: Logger;
  /** Injectable so behaviour can be reasoned about without waiting. */
  now?: () => number;
}

/** Thrown instead of calling through while the breaker is open. */
export class CircuitOpenError extends Error {
  constructor(readonly circuit: string) {
    super(`${circuit} is not responding, so the platform is not calling it right now.`);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: BreakerState = 'closed';
  /** True while the one half-open call is out, so only one ever is. */
  private probing = false;

  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  get status(): BreakerState {
    // Asked rather than driven by a timer: a breaker nobody is calling does not
    // need to be doing anything, and a timer would keep a reference alive for a
    // dependency nothing is using.
    this.considerHalfOpen();
    return this.state;
  }

  /**
   * Runs the work, unless the breaker says not to.
   *
   * Throws `CircuitOpenError` while open, which callers turn into their own
   * "unavailable" answer. It is deliberately a distinct type: a caller that
   * cannot tell "I did not try" from "I tried and it failed" would report the
   * wrong thing to the person waiting.
   */
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.considerHalfOpen();

    if (this.state === 'open') throw new CircuitOpenError(this.options.name);

    /*
     * Only one call while half open.
     *
     * The whole point of the state is to ask the dependency one question. Ten
     * concurrent requests arriving the moment it reopens would all be let
     * through, which is the flood the breaker exists to prevent.
     */
    if (this.state === 'half-open') {
      if (this.probing) throw new CircuitOpenError(this.options.name);
      this.probing = true;
    }

    try {
      const result = await work();
      this.succeed();
      return result;
    } catch (error) {
      this.fail();
      throw error;
    } finally {
      this.probing = false;
    }
  }

  private succeed(): void {
    if (this.state !== 'closed') {
      this.options.log.info({ circuit: this.options.name }, 'a circuit closed again');
    }

    this.failures = 0;
    this.state = 'closed';
  }

  private fail(): void {
    this.failures += 1;

    /*
     * A failure while half open reopens immediately.
     *
     * The one call was the question, and the answer was no. Counting up to the
     * threshold again would mean letting several through to learn what one
     * already established.
     */
    if (this.state === 'half-open' || this.failures >= this.options.threshold) {
      if (this.state !== 'open') {
        this.options.log.error(
          { circuit: this.options.name, failures: this.failures },
          'a circuit opened: calls are being refused without being attempted',
        );
      }

      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  private considerHalfOpen(): void {
    if (this.state !== 'open') return;
    if (this.now() - this.openedAt < this.options.resetAfterMs) return;

    this.state = 'half-open';
    this.probing = false;
  }
}
