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
      /** Set by requireProjectPermission. Present only on authorized routes. */
      projectAccess?: ProjectAccess;
    }
  }
}

/** Identifiers are UUIDs. Anything else cannot name a project. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guards a route behind one project capability.
 *
 * Must sit behind `requireAuth`: it needs a caller before it can ask what that
 * caller may do. Using it without one is a wiring mistake and throws loudly
 * rather than silently letting a request through.
 *
 * A malformed identifier is answered as "not found" rather than as a
 * validation error, so probing with junk cannot be distinguished from probing
 * with a real identifier that belongs to someone else.
 */
export function requireProjectPermission(
  authorization: AuthorizationService,
  permission: ProjectPermission,
  paramName = 'projectId',
) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const { user } = requireAuthContext(req);
    // Express types a route parameter as possibly repeated. A repeated one is
    // not a project identifier, so anything but a single string is refused.
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

/**
 * The authorized project context, for handlers behind the guard.
 *
 * Throws rather than returning undefined: reaching here without it means the
 * route was assembled wrongly, and that should fail loudly in development
 * rather than quietly serve someone else's project.
 */
export function requireProjectAccess(req: Request): ProjectAccess {
  if (!req.projectAccess) {
    throw new Error(
      'requireProjectAccess used on a route that is not behind requireProjectPermission',
    );
  }
  return req.projectAccess;
}
