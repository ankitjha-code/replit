import { Router, type Request, type Response } from 'express';
import { logQuerySchema, type LogQuery, type LogResponse } from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import {
  requireProjectPermission,
  requireProjectAccess,
} from '../../http/middleware/authorize-project.js';
import type { AuthorizationService } from '../projects/authorization.service.js';
import type { LogService } from './log.service.js';

export function logRoutes(options: {
  logs: LogService;
  authorization: AuthorizationService;
}): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    requireProjectPermission(options.authorization, 'runtime:read'),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);

      const parsed = logQuerySchema.safeParse(req.query);

      if (!parsed.success) {
        throw new AppError('VALIDATION_FAILED', 'That is not a log query the platform accepts', {
          details: {
            fields: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        });
      }

      const body: LogResponse = await options.logs.read(project.id, parsed.data as LogQuery);
      res.status(200).json(body);
    },
  );

  router.get(
    '/export',
    requireProjectPermission(options.authorization, 'runtime:read'),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const parsed = logQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError('VALIDATION_FAILED', 'That is not a log query the platform accepts');
      }

      const text = await options.logs.export(project.id, parsed.data as LogQuery);

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', `attachment; filename="${project.slug}.log"`);
      res.status(200).send(text);
    },
  );

  return router;
}
