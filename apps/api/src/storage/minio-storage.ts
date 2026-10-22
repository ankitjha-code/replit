import type { Readable } from 'node:stream';
import { Client } from 'minio';
import type { Logger } from 'pino';
import { AppError } from '../errors/app-error.js';
import type { StorageProvider, StoredObject } from './provider.js';

/**
 * Object storage over the S3 protocol.
 *
 * Aimed at MinIO, which runs locally in this platform's own compose file, and
 * speaks the same protocol as every hosted object store. That is the point of
 * choosing it: nothing here is tied to one vendor, and no account with anyone
 * is needed to run the platform.
 */

export interface MinioStorageOptions {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  /** How long a reachability answer is reused. */
  availabilityTtlMs: number;
}

export class MinioStorageProvider implements StorageProvider {
  readonly name = 'minio';

  private readonly client: Client;
  private availability: { reason: string | null; at: number } | undefined;
  private bucketReady = false;

  constructor(
    private readonly options: MinioStorageOptions,
    private readonly log: Logger,
  ) {
    const url = new URL(options.endpoint);
    this.client = new Client({
      endPoint: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
      useSSL: url.protocol === 'https:',
      accessKey: options.accessKey,
      secretKey: options.secretKey,
    });
  }

  /**
   * Whether the store can be reached.
   *
   * Cached briefly, like the container daemon's: every project settings page
   * asks, and a round trip per page view buys nothing.
   */
  async unavailableReason(): Promise<string | null> {
    const cached = this.availability;
    if (cached && Date.now() - cached.at < this.options.availabilityTtlMs) return cached.reason;

    let reason: string | null;
    try {
      await this.client.bucketExists(this.options.bucket);
      reason = null;
    } catch (error) {
      this.log.warn({ err: error }, 'object storage is not reachable');
      // Names what is wrong without quoting the driver, whose message carries
      // an endpoint and sometimes a key id.
      reason = 'The file store is not reachable, so files cannot be uploaded.';
    }

    this.availability = { reason, at: Date.now() };
    return reason;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.ensureBucket();

    try {
      await this.client.putObject(this.options.bucket, key, body, body.byteLength, {
        'Content-Type': contentType,
      });
    } catch (error) {
      throw this.failure(error, 'The file could not be stored.', { key });
    }
  }

  async get(key: string): Promise<Readable> {
    try {
      return await this.client.getObject(this.options.bucket, key);
    } catch (error) {
      if (isNotFound(error)) {
        // The row exists and the object does not. Worth its own answer,
        // because it means the two have drifted apart.
        throw new AppError('NOT_FOUND', 'That file is no longer stored', { context: { key } });
      }
      throw this.failure(error, 'The file could not be read.', { key });
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.removeObject(this.options.bucket, key);
    } catch (error) {
      if (isNotFound(error)) return;
      throw this.failure(error, 'The file could not be removed.', { key });
    }
  }

  /**
   * Every object under a prefix, read from a stream into a list.
   *
   * The client reports objects as an event stream because a bucket can hold
   * more than fits in memory. This collects the whole prefix, which is the right
   * shape for its one caller — cleanup, comparing a prefix against a set of
   * database rows — and the wrong shape for a bucket with millions of objects
   * under one prefix. That is a real ceiling and is written down rather than
   * guarded against, because the guard would be a page size the caller then has
   * to loop over, and nothing yet needs it.
   */
  async list(prefix: string): Promise<StoredObject[]> {
    await this.ensureBucket();

    return new Promise((resolve, reject) => {
      const found: StoredObject[] = [];
      const stream = this.client.listObjectsV2(this.options.bucket, prefix, true);

      stream.on('data', (item) => {
        // A prefix entry has no name; only real objects are of interest.
        if (!item.name) return;
        found.push({
          key: item.name,
          size: item.size ?? 0,
          lastModified: item.lastModified ? new Date(item.lastModified) : undefined,
        });
      });
      stream.on('error', (error: unknown) => {
        reject(this.failure(error, 'The stored files could not be listed.', { prefix }));
      });
      stream.on('end', () => resolve(found));
    });
  }

  /**
   * Creates the bucket if it is not there.
   *
   * Once per process. A fresh installation should work after `infra:up`
   * without a separate provisioning step nobody remembers to run.
   */
  private async ensureBucket(): Promise<void> {
    if (this.bucketReady) return;

    try {
      if (!(await this.client.bucketExists(this.options.bucket))) {
        await this.client.makeBucket(this.options.bucket);
      }
      this.bucketReady = true;
    } catch (error) {
      throw this.failure(error, 'The file store could not be prepared.', {
        bucket: this.options.bucket,
      });
    }
  }

  private failure(error: unknown, message: string, context: Record<string, unknown>): AppError {
    return new AppError('STORAGE_FAILED', message, {
      expose: true,
      cause: error,
      context: { ...context, provider: this.name },
    });
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'NoSuchKey' || code === 'NotFound';
}
