import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import { MinioStorageProvider } from './minio-storage.js';
import { ResilientStorageProvider } from './resilient-storage.js';
import type { StorageProvider } from './provider.js';
import { UnavailableStorageProvider } from './unavailable-storage.js';

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
