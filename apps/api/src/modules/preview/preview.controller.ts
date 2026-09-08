import type { Request, Response } from 'express';
import { PREVIEW_GRANT_PARAM, PREVIEW_GRANT_PATH, type PreviewState } from '@platform/shared';
import { requireAuthContext } from '../../http/middleware/authenticate.js';
import { requireProjectAccess } from '../../http/middleware/authorize-project.js';
import type { PreviewService } from './preview.service.js';

/**
 * Translates between HTTP and the preview service.
 *
 * The grant endpoint returns an address rather than a bare token, because the
 * only thing a client can do with a grant is navigate to it, and building that
 * address from parts is a way for a client to get it wrong.
 */
export class PreviewController {
  constructor(private readonly previews: PreviewService) {}

  get = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const body: PreviewState = await this.previews.describe(project.id);
    res.status(200).json(body);
  };

  grant = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const { user } = requireAuthContext(req);

    const granted = await this.previews.issueGrant(project.id, user.id);
    const url = new URL(PREVIEW_GRANT_PATH, granted.url);
    url.searchParams.set(PREVIEW_GRANT_PARAM, granted.token);

    // Never cached. The address contains a single-use secret, and a cache
    // between here and the browser would keep it after it was spent.
    res.setHeader('cache-control', 'no-store');
    res.status(201).json({ url: url.toString() });
  };
}
