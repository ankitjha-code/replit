import { Router, type Request, type Response } from 'express';
import {
  importEnvironmentRequestSchema,
  parseDotenv,
  roleHasPermission,
  setVariableRequestSchema,
  type ImportEnvironmentRequest,
  type ImportEnvironmentResponse,
  type VariableListResponse,
} from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import { requireAuthContext } from '../../http/middleware/authenticate.js';
import {
  requireProjectPermission,
  requireProjectAccess,
} from '../../http/middleware/authorize-project.js';
import { validateBody } from '../../http/middleware/validate.js';
import type { AuthorizationService } from '../projects/authorization.service.js';
import type { RuntimeService } from '../runtimes/runtime.service.js';
import type { SecretService } from '../secrets/secret.service.js';
import type { VariableService } from './variable.service.js';

/**
 * Mounted under a project, so `:projectId` is already in the path.
 *
 * Every route needs `env:read` or `env:write`, which an editor holds. That is
 * the deliberate difference from secrets next door, where both capabilities
 * belong to the owner alone: someone trusted to change what a project does is
 * trusted to see the port it listens on, and is not thereby trusted with the
 * credentials it connects with.
 *
 * A viewer gets neither. Configuration is not secret, but it is not public
 * either, and read-only access to a project is not a reason to be handed its
 * every setting.
 */
export function variableRoutes(options: {
  variables: VariableService;
  secrets: SecretService;
  runtimes: RuntimeService;
  authorization: AuthorizationService;
}): Router {
  const guard = (permission: Parameters<typeof requireProjectPermission>[1]) =>
    requireProjectPermission(options.authorization, permission);

  const router = Router({ mergeParams: true });

  router.get('/', guard('env:read'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);

    /*
     * Whether what is listed is what is running.
     *
     * A container is handed its environment when it is created, so editing a
     * variable changes the next start rather than the current one. Anything
     * still up is therefore running on values that may no longer match, and
     * saying so is the difference between restarting the project and spending
     * an afternoon wondering why a change did nothing.
     */
    const runtime = await options.runtimes.describe(project.id);

    const body: VariableListResponse = {
      variables: await options.variables.list(project.id),
      limit: options.variables.limit,
      restartRequired: runtime.runtime?.status === 'RUNNING',
    };
    res.status(200).json(body);
  });

  router.put(
    '/',
    guard('env:write'),
    validateBody(setVariableRequestSchema),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const { user } = requireAuthContext(req);
      const input = req.body as { key: string; value: string };

      const variable = await options.variables.set(project.id, user.id, input);
      res.status(200).json({ variable });
    },
  );

  /*
   * Many at once, from the text of a `.env` file.
   *
   * Each line goes through exactly the path a single variable does — reserved
   * names, the variable/secret namespace, the per-project ceiling — so an import
   * cannot do anything setting them one by one could not. It is not all-or-
   * nothing, on purpose: a file with one reserved name in it should set the
   * other nineteen and say which one was refused and why, rather than refuse the
   * lot and leave somebody hunting for the line.
   *
   * Importing as secrets needs the secret permission as well, checked here
   * rather than by the guard because the guard cannot see the body.
   */
  router.post(
    '/import',
    guard('env:write'),
    validateBody(importEnvironmentRequestSchema),
    async (req: Request, res: Response) => {
      const { project, role } = requireProjectAccess(req);
      const { user } = requireAuthContext(req);
      const input = req.body as ImportEnvironmentRequest;

      if (input.as === 'secrets' && !roleHasPermission(role, 'secret:write')) {
        throw new AppError('FORBIDDEN', 'Only somebody who may set secrets can import them.', {
          expose: true,
        });
      }

      const parsed = parseDotenv(input.text);
      const body: ImportEnvironmentResponse = {
        applied: [],
        refused: parsed.problems.map((problem) => ({
          key: null,
          line: problem.line,
          reason: problem.reason,
        })),
      };

      for (const entry of parsed.entries) {
        try {
          if (input.as === 'secrets') {
            await options.secrets.set(project.id, user.id, { key: entry.key, value: entry.value });
          } else {
            await options.variables.set(project.id, user.id, {
              key: entry.key,
              value: entry.value,
            });
          }
          body.applied.push(entry.key);
        } catch (error) {
          body.refused.push({
            key: entry.key,
            line: entry.line,
            reason:
              error instanceof AppError && error.expose
                ? error.message
                : 'This line could not be set.',
          });
        }
      }

      res.status(200).json(body);
    },
  );

  router.delete('/:key', guard('env:write'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);
    const key = req.params.key;

    if (typeof key !== 'string') {
      throw new AppError('NOT_FOUND', 'There is no environment variable with that name');
    }

    await options.variables.remove(project.id, key);
    res.status(204).end();
  });

  return router;
}
