import type { Readable } from 'node:stream';
import type { Logger } from 'pino';
import { AppError } from '../errors/app-error.js';
import { CircuitBreaker, CircuitOpenError } from '../lib/reliability/circuit-breaker.js';
import { isTransientNetworkError, withRetry } from '../lib/reliability/retry.js';
import type { StorageProvider, StoredObject } from './provider.js';

export interface ResilientStorageOptions {
  attempts: number;
  baseMs: number;
  maxMs: number;
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

  get circuitState(): string {
    return this.breaker.status;
  }

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

  list(prefix: string): Promise<StoredObject[]> {
    return this.guard('list', () => this.inner.list(prefix));
  }

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
