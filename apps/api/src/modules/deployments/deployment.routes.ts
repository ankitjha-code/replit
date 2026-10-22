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

/**
 * Mounted under a project, so `:projectId` is already in the path.
 *
 * Reading needs `deployment:read`, which a viewer has: somebody shown a project
 * should be able to see whether it is live and where. Everything that changes
 * anything needs `deployment:control`, which is an owner, because a deployment
 * is the one thing here that serves a project's code to people who have no
 * account and have agreed to nothing.
 */
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

  /**
   * How this project is built and started.
   *
   * A PUT rather than a PATCH: the fields depend on each other, and a partial
   * update would let a project be half a static site and half a server. The
   * whole configuration is sent and validated as one thing.
   */
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

  /**
   * What the build printed.
   *
   * Its own route rather than a field in the listing: a log is large, most of
   * the time nobody looks at it, and carrying it in the list would make every
   * page load pay for every build that ever ran.
   *
   * Readable by anybody who may read deployments, because a build log is the
   * project's own output. It can contain whatever the project's build script
   * printed, which is no more than a viewer could see by running it.
   */
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

  /*
   * Going back to an earlier release.
   *
   * The same permission as deploying, because it is a deploy: it makes
   * something live. A separate, weaker permission would be a way to change what
   * the public sees without being allowed to change what the public sees.
   */
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

/** The deployment a route names, or a not-found. */
function idFrom(req: Request): string {
  const raw = req.params.deploymentId;
  // Express types a route parameter as possibly repeated. A repeated one is not
  // a deployment identifier.
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new AppError('NOT_FOUND', 'There is no deployment with that identifier');
  }
  return raw;
}
