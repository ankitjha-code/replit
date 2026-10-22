import type { NextFunction, Request, Response } from 'express';
import type { ProjectPermission } from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import type {
  AuthorizationService,
  ProjectAccess,
} from '../../modules/projects/authorization.service.js';
import { requireAuthContext } from './authenticate.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      projectAccess?: ProjectAccess;
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireProjectPermission(
  authorization: AuthorizationService,
  permission: ProjectPermission,
  paramName = 'projectId',
) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const { user } = requireAuthContext(req);
    const raw = req.params[paramName];
    const projectId = typeof raw === 'string' ? raw : undefined;

    if (!projectId || !UUID.test(projectId)) {
      next(new AppError('NOT_FOUND', 'Project not found'));
      return;
    }

    req.projectAccess = await authorization.authorize(user.id, projectId, permission);
    next();
  };
}

export function requireProjectAccess(req: Request): ProjectAccess {
  if (!req.projectAccess) {
    throw new Error(
      'requireProjectAccess used on a route that is not behind requireProjectPermission',
    );
  }
  return req.projectAccess;
}
