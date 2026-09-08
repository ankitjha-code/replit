import { Router } from 'express';
import { HealthController } from './health.controller.js';
import type { HealthService } from './health.service.js';

export function healthRoutes(service: HealthService): Router {
  const controller = new HealthController(service);
  const router = Router();

  // Express 5 forwards rejected promises to the error handler, so async
  // handlers need no wrapper.
  router.get('/live', controller.live);
  router.get('/ready', controller.ready);

  return router;
}
