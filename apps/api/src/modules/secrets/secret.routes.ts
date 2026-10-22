import { Router, type Request, type Response } from 'express';
import { setSecretRequestSchema, type SecretListResponse } from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import { requireAuthContext } from '../../http/middleware/authenticate.js';
import {
  requireProjectPermission,
  requireProjectAccess,
} from '../../http/middleware/authorize-project.js';
import { validateBody } from '../../http/middleware/validate.js';
import type { AuthorizationService } from '../projects/authorization.service.js';
import type { SecretService } from './secret.service.js';

/**
 * Mounted under a project, so `:projectId` is already in the path.
 *
 * Every route needs `secret:read` or `secret:write`, both of which only an
 * owner holds. An editor can change what a project does and still cannot read
 * or set the credentials it does it with.
 *
 * There is deliberately no route that returns a value. Not a masked one, not a
 * prefix, not the last four characters: a hint is a way to confirm a guess.
 */
export function secretRoutes(options: {
  secrets: SecretService;
  authorization: AuthorizationService;
}): Router {
  const guard = (permission: Parameters<typeof requireProjectPermission>[1]) =>
    requireProjectPermission(options.authorization, permission);

  const router = Router({ mergeParams: true });

  router.get('/', guard('secret:read'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);

    const body: SecretListResponse = {
      secrets: await options.secrets.list(project.id),
      unavailableReason: options.secrets.unavailableReason(),
      limit: options.secrets.limit,
    };
    res.status(200).json(body);
  });

  router.put(
    '/',
    guard('secret:write'),
    validateBody(setSecretRequestSchema),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const { user } = requireAuthContext(req);
      const input = req.body as { key: string; value: string };

      const secret = await options.secrets.set(project.id, user.id, input);
      res.status(200).json({ secret });
    },
  );

  router.delete('/:key', guard('secret:write'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);
    const key = req.params.key;

    if (typeof key !== 'string') {
      throw new AppError('NOT_FOUND', 'There is no secret with that name');
    }

    await options.secrets.remove(project.id, key);
    res.status(204).end();
  });

  return router;
}
