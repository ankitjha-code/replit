import { Router, type Request, type Response } from 'express';
import {
  updateHealthCheckRequestSchema,
  type HealthCheckConfig,
  type MonitoringResponse,
  type UpdateHealthCheckRequest,
} from '@platform/shared';
import {
  requireProjectPermission,
  requireProjectAccess,
} from '../../http/middleware/authorize-project.js';
import { validateBody } from '../../http/middleware/validate.js';
import type { AuthorizationService } from '../projects/authorization.service.js';
import type { MonitoringService } from './monitoring.service.js';

export function monitoringRoutes(options: {
  monitoring: MonitoringService;
  authorization: AuthorizationService;
}): Router {
  const guard = (permission: Parameters<typeof requireProjectPermission>[1]) =>
    requireProjectPermission(options.authorization, permission);

  const router = Router({ mergeParams: true });

  router.get('/', guard('runtime:read'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);
    const body: MonitoringResponse = await options.monitoring.describe(project.id);
    res.status(200).json(body);
  });

  router.put(
    '/health-check',
    guard('runtime:control'),
    validateBody(updateHealthCheckRequestSchema),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const input = req.body as UpdateHealthCheckRequest;

      const body: HealthCheckConfig = await options.monitoring.setHealthCheck(project.id, input);
      res.status(200).json(body);
    },
  );

  return router;
}
