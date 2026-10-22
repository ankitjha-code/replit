import { Router, type Request, type Response } from 'express';
import {
  createDeploymentRequestSchema,
  rollbackRequestSchema,
  updateDeploymentConfigRequestSchema,
  type DeploymentConfig,
  type DeploymentLogResponse,
  type DeploymentResponse,
  type DeploymentStateResponse,
} from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import { requireAuthContext } from '../../http/middleware/authenticate.js';
import {
  requireProjectPermission,
  requireProjectAccess,
} from '../../http/middleware/authorize-project.js';
import { validateBody } from '../../http/middleware/validate.js';
import type { AuthorizationService } from '../projects/authorization.service.js';
import type { DeploymentService } from './deployment.service.js';

export function deploymentRoutes(options: {
  deployments: DeploymentService;
  authorization: AuthorizationService;
}): Router {
  const guard = (permission: Parameters<typeof requireProjectPermission>[1]) =>
    requireProjectPermission(options.authorization, permission);

  const router = Router({ mergeParams: true });

  router.get('/', guard('deployment:read'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);
    const body: DeploymentStateResponse = await options.deployments.describe(project.id);
    res.status(200).json(body);
  });

  router.put(
    '/config',
    guard('deployment:control'),
    validateBody(updateDeploymentConfigRequestSchema),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const body: DeploymentStateResponse = await options.deployments.setConfig(
        project.id,
        req.body as DeploymentConfig,
      );
      res.status(200).json(body);
    },
  );

  router.post(
    '/',
    guard('deployment:control'),
    validateBody(createDeploymentRequestSchema),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const { user } = requireAuthContext(req);
      const input = req.body as { note?: string };

      const body: DeploymentResponse = {
        deployment: await options.deployments.create(project.id, user.id, input),
      };
      res.status(201).json(body);
    },
  );

  router.get('/:deploymentId/log', guard('deployment:read'), async (req, res: Response) => {
    const { project } = requireProjectAccess(req);
    const body: DeploymentLogResponse = await options.deployments.buildLog(project.id, idFrom(req));
    res.status(200).json(body);
  });

  router.post(
    '/:deploymentId/stop',
    guard('deployment:control'),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const { user } = requireAuthContext(req);

      const body: DeploymentResponse = {
        deployment: await options.deployments.stop(project.id, idFrom(req), user.id),
      };
      res.status(200).json(body);
    },
  );

  router.post(
    '/:deploymentId/rollback',
    guard('deployment:control'),
    validateBody(rollbackRequestSchema),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const { user } = requireAuthContext(req);

      const body: DeploymentResponse = {
        deployment: await options.deployments.rollback(
          project.id,
          idFrom(req),
          user.id,
          req.body as { note?: string | undefined },
        ),
      };
      res.status(202).json(body);
    },
  );

  router.delete('/:deploymentId', guard('deployment:control'), async (req, res: Response) => {
    const { project } = requireProjectAccess(req);
    await options.deployments.remove(project.id, idFrom(req));
    res.status(204).end();
  });

  return router;
}

function idFrom(req: Request): string {
  const raw = req.params.deploymentId;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new AppError('NOT_FOUND', 'There is no deployment with that identifier');
  }
  return raw;
}
