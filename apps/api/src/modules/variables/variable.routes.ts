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
