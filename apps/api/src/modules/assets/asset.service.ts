import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { assetNameSchema, type AssetSummary } from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { StorageProvider } from '../../storage/provider.js';
import type { AssetRecord, AssetRepository } from './asset.repository.js';

export interface AssetServiceOptions {
  maxAssetBytes: number;
  maxProjectBytes: number;
}

const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

export class AssetService {
  constructor(
    private readonly assets: AssetRepository,
    private readonly storage: StorageProvider,
    private readonly options: AssetServiceOptions,
    private readonly log: Logger,
  ) {}

  async list(projectId: string): Promise<{ assets: AssetSummary[]; totalBytes: number }> {
    const records = await this.assets.listForProject(projectId);
    return {
      assets: records.map(toSummary),
      totalBytes: records.reduce((total, record) => total + record.size, 0),
    };
  }

  get limitBytes(): number {
    return this.options.maxProjectBytes;
  }

  storageUnavailable(): Promise<string | null> {
    return this.storage.unavailableReason();
  }

  async upload(
    projectId: string,
    userId: string,
    input: { name: string; contentType: string | undefined; body: Buffer },
  ): Promise<AssetSummary> {
    const reason = await this.storage.unavailableReason();
    if (reason) {
      throw new AppError('STORAGE_FAILED', reason, { expose: true, status: 503 });
    }

    const name = this.requireValidName(input.name);

    if (input.body.byteLength === 0) {
      throw new AppError('BAD_REQUEST', 'That file is empty');
    }

    if (input.body.byteLength > this.options.maxAssetBytes) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        `That file is larger than the ${formatBytes(this.options.maxAssetBytes)} limit`,
      );
    }

    const used = await this.assets.totalBytes(projectId);
    if (used + input.body.byteLength > this.options.maxProjectBytes) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        `This project would exceed its ${formatBytes(this.options.maxProjectBytes)} of file storage`,
      );
    }

    const storageKey = `projects/${projectId}/${randomUUID()}`;
    const contentType = normaliseContentType(input.contentType);
    const checksum = createHash('sha256').update(input.body).digest('hex');

    await this.storage.put(storageKey, input.body, contentType);

    try {
      const record = await this.assets.create({
        projectId,
        storageKey,
        name,
        contentType,
        size: input.body.byteLength,
        checksum,
        uploadedById: userId,
      });

      this.log.info({ projectId, assetId: record.id, size: record.size }, 'asset stored');
      return toSummary(record);
    } catch (error) {
      await this.storage.delete(storageKey).catch((cleanupError: unknown) => {
        this.log.error({ err: cleanupError, storageKey }, 'orphaned object could not be removed');
      });
      throw error;
    }
  }

  async download(
    projectId: string,
    assetId: string,
  ): Promise<{ record: AssetRecord; stream: Readable }> {
    const record = await this.requireAsset(projectId, assetId);
    return { record, stream: await this.storage.get(record.storageKey) };
  }

  async remove(projectId: string, assetId: string): Promise<void> {
    const record = await this.requireAsset(projectId, assetId);

    await this.assets.deleteById(projectId, assetId);

    try {
      await this.storage.delete(record.storageKey);
    } catch (error) {
      this.log.error(
        { err: error, projectId, assetId, storageKey: record.storageKey },
        'asset row removed but its object could not be deleted',
      );
    }
  }

  private async requireAsset(projectId: string, assetId: string): Promise<AssetRecord> {
    const record = await this.assets.findById(projectId, assetId);
    if (!record) throw new AppError('NOT_FOUND', 'That file does not exist');
    return record;
  }

  private requireValidName(input: string): string {
    const result = assetNameSchema.safeParse(input);
    if (!result.success) {
      throw new AppError('VALIDATION_FAILED', 'That file name cannot be used', {
        details: {
          fields: [{ path: 'name', message: result.error.issues[0]?.message ?? 'Invalid name' }],
        },
      });
    }
    return result.data;
  }
}

function toSummary(record: AssetRecord): AssetSummary {
  return {
    id: record.id,
    name: record.name,
    contentType: record.contentType,
    size: record.size,
    checksum: record.checksum,
    createdAt: record.createdAt.toISOString(),
  };
}

export function normaliseContentType(value: string | undefined): string {
  if (!value) return FALLBACK_CONTENT_TYPE;

  const base = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return CONTENT_TYPE.test(base) ? base : FALLBACK_CONTENT_TYPE;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.round(bytes / 1024)} kB`;
}
