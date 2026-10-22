import { Router, type RequestHandler } from 'express';
import { HealthController } from './health.controller.js';
import type { HealthService } from './health.service.js';

export function healthRoutes(service: HealthService, attachSession?: RequestHandler): Router {
  const controller = new HealthController(service);
  const router = Router();

  router.get('/live', controller.live);
  router.get('/ready', ...(attachSession ? [attachSession] : []), controller.ready);

  return router;
}
