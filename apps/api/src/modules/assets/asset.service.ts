import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { assetNameSchema, type AssetSummary } from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { StorageProvider } from '../../storage/provider.js';
import type { AssetRecord, AssetRepository } from './asset.repository.js';

/**
 * Project assets.
 *
 * Every rule about what a project may store lives here: how large, how many
 * bytes in total, what a file is called, and what happens when the object
 * store and the database disagree.
 *
 * The rule that matters most is the last one. A row saying a file exists when
 * the bytes do not is a promise the platform cannot keep, so the bytes are
 * written first and the row second, and a failure to record removes what was
 * just written.
 */

export interface AssetServiceOptions {
  maxAssetBytes: number;
  maxProjectBytes: number;
}

/**
 * Content type used when the uploader offers none, or offers nonsense.
 *
 * Not a guess at what the file is. Assets are served as downloads with
 * sniffing turned off, so the type is a label rather than an instruction, and
 * a wrong label must not become a way to have something rendered.
 */
const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/** A conservative shape for a media type: a token, a slash, a token. */
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

  /** Why uploading is unavailable, or null when it is not. */
  storageUnavailable(): Promise<string | null> {
    return this.storage.unavailableReason();
  }

  /**
   * Stores a file against a project.
   *
   * The storage key is generated rather than derived from the name. A key
   * built from a name is a path built from user input, and every traversal
   * defence downstream then has to be perfect.
   */
  async upload(
    projectId: string,
    userId: string,
    input: { name: string; contentType: string | undefined; body: Buffer },
  ): Promise<AssetSummary> {
    const reason = await this.storage.unavailableReason();
    if (reason) {
      // Refused before anything is written, so no row describes an object that
      // will never exist.
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
      // The bytes are already there and nothing points at them. Left alone
      // they would occupy the project's quota for ever with no way to see or
      // remove them.
      await this.storage.delete(storageKey).catch((cleanupError: unknown) => {
        this.log.error({ err: cleanupError, storageKey }, 'orphaned object could not be removed');
      });
      throw error;
    }
  }

  /**
   * The bytes, with what is needed to send them safely.
   *
   * The caller is expected to serve this as a download. Rendering a file
   * someone uploaded on the platform's own origin is how an upload becomes a
   * way to run code as whoever opens it.
   */
  async download(
    projectId: string,
    assetId: string,
  ): Promise<{ record: AssetRecord; stream: Readable }> {
    const record = await this.requireAsset(projectId, assetId);
    return { record, stream: await this.storage.get(record.storageKey) };
  }

  /**
   * Removes an asset.
   *
   * The row goes first. If the object outlives it the project loses nothing it
   * can see, whereas a row pointing at nothing is a file that appears in a
   * listing and fails every time anyone opens it.
   */
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

/**
 * Reduces whatever the uploader claimed to something safe to store.
 *
 * Parameters are dropped and anything unrecognisable becomes the fallback, so
 * the stored value cannot carry a header injection or a second type.
 */
export function normaliseContentType(value: string | undefined): string {
  if (!value) return FALLBACK_CONTENT_TYPE;

  const base = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return CONTENT_TYPE.test(base) ? base : FALLBACK_CONTENT_TYPE;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.round(bytes / 1024)} kB`;
}
