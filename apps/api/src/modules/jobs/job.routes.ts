import { Router, type Request, type Response } from 'express';
import type { JobListResponse } from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import {
  requireProjectPermission,
  requireProjectAccess,
} from '../../http/middleware/authorize-project.js';
import type { AuthorizationService } from '../projects/authorization.service.js';
import type { JobService } from './job.service.js';

export function jobRoutes(options: {
  jobs: JobService;
  workerRunning: () => boolean;
  authorization: AuthorizationService;
}): Router {
  const guard = (permission: Parameters<typeof requireProjectPermission>[1]) =>
    requireProjectPermission(options.authorization, permission);

  const router = Router({ mergeParams: true });

  router.get('/', guard('runtime:read'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);

    const body: JobListResponse = {
      jobs: await options.jobs.list(project.id),
      workerRunning: options.workerRunning(),
    };
    res.status(200).json(body);
  });

  router.post('/:jobId/cancel', guard('runtime:control'), async (req, res: Response) => {
    const { project } = requireProjectAccess(req);
    res.status(200).json({ job: await options.jobs.cancel(project.id, idFrom(req)) });
  });

  return router;
}

function idFrom(req: Request): string {
  const raw = req.params.jobId;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new AppError('NOT_FOUND', 'There is no job with that identifier');
  }
  return raw;
}
