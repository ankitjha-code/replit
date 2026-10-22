import { Router, type Request, type Response } from 'express';
import type { JobListResponse } from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import {
  requireProjectPermission,
  requireProjectAccess,
} from '../../http/middleware/authorize-project.js';
import type { AuthorizationService } from '../projects/authorization.service.js';
import type { JobService } from './job.service.js';

/**
 * Mounted under a project, so `:projectId` is already in the path.
 *
 * Reading needs `runtime:read`, which a viewer has: what the platform is doing
 * for a project is the same kind of fact as whether it is running. Cancelling
 * needs `runtime:control`, because the work being abandoned is work somebody
 * with that capability asked for.
 *
 * There is no route that creates a job. Jobs are created by the services that
 * need them, from the requests people actually make — an endpoint that queued
 * arbitrary work would be a way to make the platform do things without going
 * through the checks that decide whether it should.
 */
export function jobRoutes(options: {
  jobs: JobService;
  /** Whether this process is running a worker, which the page has to be told. */
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
      /*
       * Whether anything is picking this up.
       *
       * Only this process is known: a worker running elsewhere cannot be seen
       * from here, and claiming otherwise would be inventing a fact. So the
       * honest reading of `false` is "not by me", which the page says in those
       * terms rather than as "nothing is running".
       */
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

/** The job a route names, or a not-found. */
function idFrom(req: Request): string {
  const raw = req.params.jobId;
  // Express types a route parameter as possibly repeated. A repeated one is not
  // a job identifier.
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new AppError('NOT_FOUND', 'There is no job with that identifier');
  }
  return raw;
}
