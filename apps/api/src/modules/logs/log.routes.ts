import { Router, type Request, type Response } from 'express';
import { logQuerySchema, type LogQuery, type LogResponse } from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import {
  requireProjectPermission,
  requireProjectAccess,
} from '../../http/middleware/authorize-project.js';
import type { AuthorizationService } from '../projects/authorization.service.js';
import type { LogService } from './log.service.js';

/**
 * Mounted under a project, so `:projectId` is already in the path.
 *
 * Needs `runtime:read`, which a viewer has. A log is what the project's own
 * application printed, and somebody shown a project can already watch that same
 * output live in the console: making the stored copy harder to reach than the
 * live one would be a distinction without a reason.
 *
 * Read-only. There is no route that writes a line and no route that deletes
 * one. A log somebody could edit is not a record of anything, and retention is
 * the platform's decision rather than a person's.
 */
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

      /*
       * The query string is parsed against the contract rather than read.
       *
       * Every value here reaches a database query: a source, a stream, a cursor
       * and a limit. The limit in particular is the difference between a page
       * and an attempt to render a project's entire history.
       */
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

  /*
   * Everything the project still has, as a file.
   *
   * Plain text, as an attachment, with sniffing refused: a log is somebody's
   * program's output, and a browser guessing it was HTML and rendering it on the
   * API's origin would turn a download into a script running as the reader.
   */
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
