import { Router, type Request, type Response } from 'express';
import {
  createPreviewShareRequestSchema,
  type CreatePreviewShareRequest,
  type PreviewShare,
} from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import { requireAuthContext } from '../../http/middleware/authenticate.js';
import {
  requireProjectAccess,
  requireProjectPermission,
} from '../../http/middleware/authorize-project.js';
import { validateBody } from '../../http/middleware/validate.js';
import type { PreviewShareRecord } from './preview.repository.js';
import type { AuthorizationService } from '../projects/authorization.service.js';
import { PreviewController } from './preview.controller.js';
import type { PreviewService } from './preview.service.js';

export interface PreviewRouteOptions {
  previews: PreviewService;
  authorization: AuthorizationService;
}

/**
 * Mounted under a project.
 *
 * Both routes need only `runtime:read`, which a viewer has: someone shown a
 * project should be able to see what it serves. A preview is a way to look at
 * a project, not a way to change one.
 */
export function previewRoutes(options: PreviewRouteOptions): Router {
  const controller = new PreviewController(options.previews);
  const guard = requireProjectPermission(options.authorization, 'runtime:read');

  const router = Router({ mergeParams: true });

  router.get('/', guard, controller.get);
  router.post('/grant', guard, controller.grant);

  /*
   * Share links.
   *
   * The deploy permission, not the preview one: a share shows the project's
   * running code to people with no account here, which is the same decision as
   * deploying it and belongs to the same people.
   */
  const canShare = requireProjectPermission(options.authorization, 'deployment:control');

  router.get('/shares', canShare, async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);
    const shares = await options.previews.listShares(project.id);
    res.status(200).json({ shares: shares.map(toShare) });
  });

  router.post(
    '/shares',
    canShare,
    validateBody(createPreviewShareRequestSchema),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const { user } = requireAuthContext(req);
      const { share, url } = await options.previews.createShare(
        project.id,
        user.id,
        req.body as CreatePreviewShareRequest,
      );
      // The URL once, here. Only its hash is kept.
      res.status(201).json({ share: toShare(share), url });
    },
  );

  router.delete('/shares/:shareId', canShare, async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);
    const raw: unknown = req.params.shareId;
    if (typeof raw !== 'string') throw new AppError('NOT_FOUND', 'No such share link');
    await options.previews.revokeShare(project.id, raw);
    res.status(204).end();
  });

  return router;
}

function toShare(record: PreviewShareRecord): PreviewShare {
  return {
    id: record.id,
    label: record.label,
    createdBy: record.createdBy?.username ?? null,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    revokedAt: record.revokedAt?.toISOString() ?? null,
  };
}
