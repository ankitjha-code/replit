import type { Readable } from 'node:stream';
import { Client } from 'minio';
import type { Logger } from 'pino';
import { AppError } from '../errors/app-error.js';
import type { StorageProvider, StoredObject } from './provider.js';

export interface MinioStorageOptions {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
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

  async unavailableReason(): Promise<string | null> {
    const cached = this.availability;
    if (cached && Date.now() - cached.at < this.options.availabilityTtlMs) return cached.reason;

    let reason: string | null;
    try {
      await this.client.bucketExists(this.options.bucket);
      reason = null;
    } catch (error) {
      this.log.warn({ err: error }, 'object storage is not reachable');
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

  async list(prefix: string): Promise<StoredObject[]> {
    await this.ensureBucket();

    return new Promise((resolve, reject) => {
      const found: StoredObject[] = [];
      const stream = this.client.listObjectsV2(this.options.bucket, prefix, true);

      stream.on('data', (item) => {
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
