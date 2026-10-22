import { z } from 'zod';

/**
 * Project assets: the files that are not source.
 *
 * Images, fonts, sample data, a recording someone attached to an issue. They
 * live in object storage rather than in the platform database, because they
 * are large, rarely change, and are streamed rather than read and rewritten.
 * Source files are the opposite on every count, which is why the two are kept
 * apart rather than sharing one table with a size limit.
 */

/**
 * The longest a display name may be.
 *
 * Long enough for anything a person would recognise, short enough that a name
 * cannot be used to make a listing unreadable.
 */
export const MAX_ASSET_NAME_LENGTH = 255;

/**
 * What a name may not contain.
 *
 * A display name is never used to address anything: the storage key is
 * generated. This only keeps a listing readable and keeps a name from being
 * mistaken for a path if some later code does use it as one.
 */
export const assetNameSchema = z
  .string()
  .trim()
  .min(1, 'Give the file a name')
  .max(MAX_ASSET_NAME_LENGTH)
  .refine((name) => !name.includes('/') && !name.includes('\\'), 'A name cannot contain a path')
  .refine((name) => !name.includes('\0'), 'A name cannot contain a null byte')
  .refine((name) => name !== '.' && name !== '..', 'That is not a name');

export const assetSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * What the uploader said it was.
   *
   * Recorded, and deliberately not trusted: every asset is served as a
   * download with sniffing turned off, so a file claiming to be an image and
   * containing a page cannot be rendered as one.
   */
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  /** SHA-256 of the bytes, so a caller can tell whether it already has them. */
  checksum: z.string(),
  createdAt: z.string(),
});

export type AssetSummary = z.infer<typeof assetSummarySchema>;

export const assetListResponseSchema = z.object({
  assets: z.array(assetSummarySchema),
  /** Bytes used, against the project's ceiling. */
  totalBytes: z.number().int().nonnegative(),
  limitBytes: z.number().int().positive(),
});

export type AssetListResponse = z.infer<typeof assetListResponseSchema>;

export const assetUploadResponseSchema = z.object({ asset: assetSummarySchema });

/** The header an upload carries its display name in. */
export const ASSET_NAME_HEADER = 'x-asset-name';
