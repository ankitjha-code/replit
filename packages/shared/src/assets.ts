import { z } from 'zod';

export const MAX_ASSET_NAME_LENGTH = 255;

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
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  checksum: z.string(),
  createdAt: z.string(),
});

export type AssetSummary = z.infer<typeof assetSummarySchema>;

export const assetListResponseSchema = z.object({
  assets: z.array(assetSummarySchema),
  totalBytes: z.number().int().nonnegative(),
  limitBytes: z.number().int().positive(),
});

export type AssetListResponse = z.infer<typeof assetListResponseSchema>;

export const assetUploadResponseSchema = z.object({ asset: assetSummarySchema });

export const ASSET_NAME_HEADER = 'x-asset-name';
