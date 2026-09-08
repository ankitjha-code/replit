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

/**
 * Mounted under a project, so `:projectId` is already in the path.
 *
 * Reading needs `runtime:read`, which a viewer has: what a project is using and
 * whether it answers is the same kind of fact as whether it is running, and a
 * viewer can already see that. Changing how it is checked needs
 * `runtime:control`, because it is a setting about the project rather than an
 * observation of it.
 *
 * Every reading is taken when it is asked for. There is no stored history to
 * page through and no endpoint that writes a measurement, which is deliberate:
 * see the note on the service.
 */
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

  /**
   * Changes what the health check asks for.
   *
   * A PUT: the path and the timeout are one setting, and a partial update would
   * let a project end up with a timeout somebody chose for a path they have
   * since changed.
   */
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
