import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import { MinioStorageProvider } from './minio-storage.js';
import { ResilientStorageProvider } from './resilient-storage.js';
import type { StorageProvider } from './provider.js';
import { UnavailableStorageProvider } from './unavailable-storage.js';

/**
 * Chooses where bytes are kept.
 *
 * Configured or not, rather than by naming a provider: object storage is
 * addressed by one protocol, so an endpoint with credentials is the whole
 * decision. Anything absent means the platform has nowhere to put files, and
 * it says so.
 */
export function createStorageProvider(config: Env, log: Logger): StorageProvider {
  const { STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY } = config;

  if (!STORAGE_ENDPOINT || !STORAGE_BUCKET || !STORAGE_ACCESS_KEY || !STORAGE_SECRET_KEY) {
    return new UnavailableStorageProvider();
  }

  const store = new MinioStorageProvider(
    {
      endpoint: STORAGE_ENDPOINT,
      bucket: STORAGE_BUCKET,
      accessKey: STORAGE_ACCESS_KEY,
      secretKey: STORAGE_SECRET_KEY,
      availabilityTtlMs: config.STORAGE_AVAILABILITY_TTL_MS,
    },
    log,
  );

  /*
   * Wrapped, rather than taught to retry itself.
   *
   * The driver's job is to talk to an object store; deciding what to do when
   * that does not work is a different job, and putting a retry policy inside a
   * driver makes both harder to reason about. It is this dependency and not
   * another because it is reached over the network on every snapshot, every
   * deployment artifact and every asset — and because its failures currently
   * surface as raw driver errors in the middle of somebody's build.
   *
   * The unavailable provider below is not wrapped: there is nothing to retry
   * about a refusal that is already certain.
   */
  return new ResilientStorageProvider(
    store,
    {
      attempts: config.STORAGE_RETRY_ATTEMPTS,
      baseMs: config.STORAGE_RETRY_BASE_MS,
      maxMs: config.STORAGE_RETRY_MAX_MS,
      breakerThreshold: config.STORAGE_BREAKER_THRESHOLD,
      breakerResetMs: config.STORAGE_BREAKER_RESET_MS,
    },
    log,
  );
}
