import type { Request, Response } from 'express';
import { ASSET_NAME_HEADER, type AssetListResponse } from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import { requireAuthContext } from '../../http/middleware/authenticate.js';
import { requireProjectAccess } from '../../http/middleware/authorize-project.js';
import type { AssetService } from './asset.service.js';

/**
 * Translates between HTTP and the asset service.
 *
 * An upload is the raw bytes as the request body, with the name in a header.
 * Multipart would be the conventional choice and buys nothing here: the
 * platform accepts one file at a time and has no other fields to carry, so the
 * encoding would only add a parser between the socket and the bytes.
 */
export class AssetController {
  constructor(private readonly assets: AssetService) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const { assets, totalBytes } = await this.assets.list(project.id);

    const body: AssetListResponse = {
      assets,
      totalBytes,
      limitBytes: this.assets.limitBytes,
    };
    res.status(200).json(body);
  };

  upload = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const { user } = requireAuthContext(req);

    const name = req.get(ASSET_NAME_HEADER);
    if (!name) {
      throw new AppError('BAD_REQUEST', 'The upload did not say what the file is called');
    }

    const asset = await this.assets.upload(project.id, user.id, {
      name,
      contentType: req.get('content-type'),
      body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    });

    res.status(201).json({ asset });
  };

  download = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const assetId = req.params.assetId;

    if (typeof assetId !== 'string') {
      throw new AppError('NOT_FOUND', 'That file does not exist');
    }

    const { record, stream } = await this.assets.download(project.id, assetId);

    /*
     * Sent as a download, never rendered.
     *
     * These bytes came from a person and would otherwise be served from the
     * platform's own origin. A file claiming to be an image and containing a
     * page would then run as the person who opened it, with their session.
     * The attachment disposition and the sniffing header are what stop that,
     * and the empty content policy stops anything the browser does render.
     */
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Length', record.size);
    res.setHeader('Content-Disposition', `attachment; filename="${asciiFilename(record.name)}"`);

    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const assetId = req.params.assetId;

    if (typeof assetId !== 'string') {
      throw new AppError('NOT_FOUND', 'That file does not exist');
    }

    await this.assets.remove(project.id, assetId);
    res.status(204).end();
  };
}

/**
 * A filename safe to put in a header.
 *
 * Quotes and control characters would end the header value early, and anything
 * outside ASCII is not permitted there at all. The stored name is unchanged;
 * this is only what the header says.
 */
export function asciiFilename(name: string): string {
  const cleaned = name.replace(/[^ -~]/g, '_').replace(/["\\]/g, '_');
  return cleaned.length > 0 ? cleaned : 'download';
}
