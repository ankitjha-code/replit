import { Router } from 'express';
import {
  runSweepRequestSchema,
  setHostDrainRequestSchema,
  setOperatorRequestSchema,
  setQuotaOverrideRequestSchema,
} from '@platform/shared';
import { requireAuth, requireOperator } from '../../http/middleware/authenticate.js';
import { validateBody } from '../../http/middleware/validate.js';
import { OperationsController } from './operations.controller.js';
import type { OperationsService } from './operations.service.js';

export interface OperationsRouteOptions {
  operations: OperationsService;
}

/**
 * The installation-wide surface, behind the operator guard.
 *
 * The guard is mounted on the router rather than repeated per route, because a
 * route added here later must not be able to be added without it. Somebody who
 * is signed in and not an operator gets *not found* from every path below —
 * which is what the platform has for them.
 */
export function operationsRoutes(options: OperationsRouteOptions): Router {
  const controller = new OperationsController(options.operations);
  const router = Router();

  router.use(requireAuth(), requireOperator());

  router.get('/overview', controller.overview);
  router.get('/hosts', controller.hosts);
  router.get('/accounts', controller.accounts);
  router.get('/audit', controller.audit);

  router.put(
    '/accounts/:accountId/operator',
    validateBody(setOperatorRequestSchema),
    controller.setOperator,
  );

  router.put('/hosts/:hostName/drain', validateBody(setHostDrainRequestSchema), controller.drain);

  router.get('/accounts/:accountId/quotas', controller.quotas);
  router.put(
    '/accounts/:accountId/quotas',
    validateBody(setQuotaOverrideRequestSchema),
    controller.setQuota,
  );

  /*
   * A POST, and it defaults to the dry run.
   *
   * POST rather than GET because it can delete containers — a GET that changes
   * things is one a browser, a crawler or a link preview will eventually make on
   * somebody's behalf. The default is the harmless one, so a request that forgot
   * to say what it wanted does nothing.
   */
  router.post('/sweep', validateBody(runSweepRequestSchema), controller.sweep);

  return router;
}
