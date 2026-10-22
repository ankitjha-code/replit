import type { Readable } from 'node:stream';
import { AppError } from '../errors/app-error.js';
import type { StorageProvider, StoredObject } from './provider.js';

/**
 * The store used when the platform has nowhere to put bytes.
 *
 * Not a stub that swallows writes. An installation with no object store
 * configured cannot hold assets, and saying so is the only honest answer: a
 * provider that accepted a file and dropped it would leave a row in the
 * database describing an object nobody can ever read.
 */
export class UnavailableStorageProvider implements StorageProvider {
  readonly name = 'none';

  constructor(
    private readonly reason = 'This installation has no object storage configured, so files cannot be uploaded.',
  ) {}

  unavailableReason(): Promise<string | null> {
    return Promise.resolve(this.reason);
  }

  put(): Promise<void> {
    return Promise.reject(this.refuse());
  }

  get(): Promise<Readable> {
    return Promise.reject(this.refuse());
  }

  /**
   * Nothing is stored, so nothing needs removing.
   *
   * True rather than an error, and cleanup after a failed upload depends on
   * being able to ask for a state that already holds.
   */
  delete(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Nothing was stored, so nothing was left behind.
   *
   * Empty rather than a refusal, for the reason the execution provider's
   * listing is: cleanup that cannot enumerate must do nothing, and cleanup that
   * enumerated nothing is finished. Only the second of those is true here.
   */
  list(): Promise<StoredObject[]> {
    return Promise.resolve([]);
  }

  private refuse(): AppError {
    return new AppError('STORAGE_FAILED', this.reason, { expose: true, status: 503 });
  }
}
