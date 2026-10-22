import type { Readable } from 'node:stream';

/**
 * The boundary between the platform and wherever bytes are kept.
 *
 * The same shape as the execution port and for the same reason: the platform
 * decides what should exist and something else holds it. An installation with
 * no object store configured refuses honestly rather than pretending to have
 * stored something.
 *
 * ## Rules any implementation must keep
 *
 * 1. **A key is opaque.** Callers hand over keys the platform generated. An
 *    implementation must never interpret one as a path relative to anything a
 *    caller controls.
 * 2. **A write either happened or it did not.** A partial object must not be
 *    readable, because a caller has recorded in the database that it is there.
 * 3. **Deleting something absent succeeds.** Cleaning up after a failure
 *    depends on it.
 */

/**
 * One stored object, as the store describes it.
 *
 * `lastModified` is what cleanup is actually interested in: an object written a
 * moment before its row exists is an ordinary race, and one written a week ago
 * with no row is a leak.
 */
export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date | undefined;
}

export interface StorageProvider {
  /** Recorded nowhere yet, but useful in a health probe and in logs. */
  readonly name: string;

  /**
   * Why this store cannot be used, or null when it can.
   *
   * Asked before anything is written, so an installation with no object store
   * refuses rather than recording rows describing objects that do not exist.
   */
  unavailableReason(): Promise<string | null>;

  put(key: string, body: Buffer, contentType: string): Promise<void>;

  /** The bytes, as a stream. Streamed because an asset may be large. */
  get(key: string): Promise<Readable>;

  /** Succeeds when the object is already gone. */
  delete(key: string): Promise<void>;

  /**
   * Every object under one prefix.
   *
   * Added for cleanup, which cannot find an abandoned object any other way: the
   * platform's record of what it stored is a row, and an object whose row is
   * gone is unreachable by every other route in this interface.
   *
   * A prefix rather than the whole bucket, because the bucket may hold things
   * this platform did not put there and enumerating them would be the first step
   * to removing one.
   */
  list(prefix: string): Promise<StoredObject[]>;
}
