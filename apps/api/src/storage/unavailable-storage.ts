import type { Readable } from 'node:stream';
import { AppError } from '../errors/app-error.js';
import type { StorageProvider, StoredObject } from './provider.js';

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

  delete(): Promise<void> {
    return Promise.resolve();
  }

  list(): Promise<StoredObject[]> {
    return Promise.resolve([]);
  }

  private refuse(): AppError {
    return new AppError('STORAGE_FAILED', this.reason, { expose: true, status: 503 });
  }
}
