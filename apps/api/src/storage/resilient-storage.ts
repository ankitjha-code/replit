import type { Readable } from 'node:stream';
import type { Logger } from 'pino';
import { AppError } from '../errors/app-error.js';
import { CircuitBreaker, CircuitOpenError } from '../lib/reliability/circuit-breaker.js';
import { isTransientNetworkError, withRetry } from '../lib/reliability/retry.js';
import type { StorageProvider, StoredObject } from './provider.js';

/**
 * Object storage, with the failures it actually has taken seriously.
 *
 * A decorator rather than something built into the MinIO provider, for the
 * reason every port in this codebase exists: the provider's job is to talk to an
 * object store, and this one's is to decide what to do when talking to it does
 * not work. Mixing them would put a retry policy inside a driver and make both
 * harder to reason about.
 *
 * Object storage is the dependency most worth wrapping. It is reached over the
 * network on every snapshot, every deployment artifact and every asset; it is
 * the one that fails transiently most often; and it is the one whose failures
 * currently surface as raw driver errors in the middle of somebody's build.
 *
 * ## Reads and writes are treated differently, on purpose
 *
 * A failed **read** can always be retried: asking for an object twice returns
 * the same bytes or the same absence.
 *
 * A failed **write** is retried too, but only because of what a write is here:
 * every key this platform generates is unique and written once, so repeating one
 * either overwrites identical bytes or completes what was half done. That is a
 * property of how the callers use the store, not of object storage in general,
 * and it is why this reasoning is written down rather than assumed.
 *
 * A failed **delete** is retried for the same reason deletes are idempotent
 * everywhere else here: removing something already gone is the outcome asked
 * for.
 */

export interface ResilientStorageOptions {
  attempts: number;
  baseMs: number;
  maxMs: number;
  /** Consecutive failures before calls stop being attempted at all. */
  breakerThreshold: number;
  breakerResetMs: number;
}

export class ResilientStorageProvider implements StorageProvider {
  readonly name: string;

  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly inner: StorageProvider,
    private readonly options: ResilientStorageOptions,
    private readonly log: Logger,
  ) {
    this.name = inner.name;
    this.breaker = new CircuitBreaker({
      name: `storage:${inner.name}`,
      threshold: options.breakerThreshold,
      resetAfterMs: options.breakerResetMs,
      log,
    });
  }

  /** What the breaker currently thinks, for the health page. */
  get circuitState(): string {
    return this.breaker.status;
  }

  /**
   * Why the store cannot be used, or null when it can.
   *
   * Deliberately **not** behind the breaker or the retry. This is the question
   * "is it working", asked by a health probe and before every write, and running
   * it through a breaker would mean the answer to "is it working" became "the
   * platform has decided not to ask" — which is true and useless.
   *
   * An open breaker is reported here as its own reason, because it is one: the
   * store may well be fine and the platform is not calling it.
   */
  async unavailableReason(): Promise<string | null> {
    if (this.breaker.status === 'open') {
      return 'The object store has been failing, so the platform has stopped calling it for a moment.';
    }

    return this.inner.unavailableReason();
  }

  put(key: string, body: Buffer, contentType: string): Promise<void> {
    return this.guard('write', () => this.inner.put(key, body, contentType));
  }

  get(key: string): Promise<Readable> {
    return this.guard('read', () => this.inner.get(key));
  }

  delete(key: string): Promise<void> {
    return this.guard('delete', () => this.inner.delete(key));
  }

  /**
   * Listing is retried like a read, because it is one.
   *
   * Asking twice returns the same keys, and the caller — cleanup — is the one
   * caller for which a transient failure that reached it would mean a whole
   * sweep skipped rather than one file.
   */
  list(prefix: string): Promise<StoredObject[]> {
    return this.guard('list', () => this.inner.list(prefix));
  }

  /**
   * One operation, retried while it looks transient and refused while the
   * breaker is open.
   *
   * The order matters: the breaker is outside the retry. Inside it, a single
   * call with three attempts would count as one failure however many times it
   * actually failed, and a breaker that counts calls rather than failures takes
   * three times as long to notice an outage.
   */
  private async guard<T>(kind: string, work: () => Promise<T>): Promise<T> {
    try {
      return await this.breaker.run(() =>
        withRetry(work, {
          attempts: this.options.attempts,
          baseMs: this.options.baseMs,
          maxMs: this.options.maxMs,
          isTransient: isTransientNetworkError,
          onRetry: (error, attempt, delayMs) => {
            this.log.warn(
              { err: error, kind, attempt, delayMs },
              'an object store call failed and is being tried again',
            );
          },
        }),
      );
    } catch (error) {
      /*
       * A refusal the platform made, turned into one a person can read.
       *
       * Distinguished from a failure of the store itself, because they are
       * different facts: one says the store is broken, and the other says the
       * platform stopped asking. Somebody reading a message about their snapshot
       * deserves the second rather than a driver error about a socket.
       */
      if (error instanceof CircuitOpenError) {
        throw new AppError(
          'SERVICE_UNAVAILABLE',
          'The object store has been failing, so the platform has stopped calling it for a moment. Try again shortly.',
          { expose: true, cause: error },
        );
      }

      throw error;
    }
  }
}
