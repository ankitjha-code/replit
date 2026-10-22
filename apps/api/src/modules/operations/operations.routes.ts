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

  router.post('/sweep', validateBody(runSweepRequestSchema), controller.sweep);

  return router;
}
