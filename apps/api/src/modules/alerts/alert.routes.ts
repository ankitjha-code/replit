import { Router, type Request, type Response } from 'express';
import { updateAlertSettingsRequestSchema, type AlertSettings } from '@platform/shared';
import {
  requireProjectAccess,
  requireProjectPermission,
} from '../../http/middleware/authorize-project.js';
import { validateBody } from '../../http/middleware/validate.js';
import type { AuthorizationService } from '../projects/authorization.service.js';
import type { AlertService } from './alert.service.js';

export function alertRoutes(options: {
  alerts: AlertService;
  authorization: AuthorizationService;
}): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    requireProjectPermission(options.authorization, 'runtime:read'),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      res.status(200).json(await options.alerts.describe(project.id));
    },
  );

  router.put(
    '/',
    requireProjectPermission(options.authorization, 'deployment:control'),
    validateBody(updateAlertSettingsRequestSchema),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      res.status(200).json(await options.alerts.update(project.id, req.body as AlertSettings));
    },
  );

  return router;
}
