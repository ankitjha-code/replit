import { Router, type RequestHandler } from 'express';
import { HealthController } from './health.controller.js';
import type { HealthService } from './health.service.js';

/**
 * @param attachSession Resolves the caller's session for readiness, so an
 *   operator gets the full report. Health is mounted ahead of the session
 *   middleware and the rate limiter, so it brings its own.
 */
export function healthRoutes(service: HealthService, attachSession?: RequestHandler): Router {
  const controller = new HealthController(service);
  const router = Router();

  // Express 5 forwards rejected promises to the error handler, so async
  // handlers need no wrapper.
  router.get('/live', controller.live);
  router.get('/ready', ...(attachSession ? [attachSession] : []), controller.ready);

  return router;
}
