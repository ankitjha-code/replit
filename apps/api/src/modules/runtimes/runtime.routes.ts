import { Router } from 'express';
import { setRunCommandRequestSchema, startRuntimeRequestSchema } from '@platform/shared';
import { requireProjectPermission } from '../../http/middleware/authorize-project.js';
import { rateLimit, type RateLimitStore } from '../../http/middleware/rate-limit.js';
import { validateBody } from '../../http/middleware/validate.js';
import type { AuthorizationService } from '../projects/authorization.service.js';
import { RuntimeController } from './runtime.controller.js';
import type { RunService } from './run.service.js';
import type { RuntimeService } from './runtime.service.js';
import type { TerminalSessionService } from './terminal-session.service.js';

export interface RuntimeRouteOptions {
  runtimes: RuntimeService;
  runs: RunService;
  terminals: TerminalSessionService;
  authorization: AuthorizationService;
  rateLimitStore: RateLimitStore;
  controlMax: number;
  controlWindowMs: number;
}

export function runtimeRoutes(options: RuntimeRouteOptions): Router {
  const controller = new RuntimeController(options.runtimes, options.runs, options.terminals);
  const guard = (permission: Parameters<typeof requireProjectPermission>[1]) =>
    requireProjectPermission(options.authorization, permission);

  const router = Router({ mergeParams: true });

  const control = rateLimit({
    bucket: 'runtime:control',
    store: options.rateLimitStore,
    max: options.controlMax,
    windowMs: options.controlWindowMs,
    keyOf: (req) => req.auth?.user.id ?? req.ip ?? 'unknown',
  });

  router.get('/', guard('runtime:read'), controller.get);
  router.get('/events', guard('runtime:read'), controller.history);

  router.post(
    '/start',
    guard('runtime:control'),
    control,
    validateBody(startRuntimeRequestSchema),
    controller.start,
  );
  router.post('/stop', guard('runtime:control'), control, controller.stop);

  router.post('/sync', guard('file:write'), control, controller.sync);

  router.get('/run', guard('runtime:read'), controller.run);
  router.post('/run/start', guard('runtime:control'), control, controller.startRun);
  router.post('/run/stop', guard('runtime:control'), control, controller.stopRun);
  router.put(
    '/run/command',
    guard('project:update'),
    validateBody(setRunCommandRequestSchema),
    controller.setRunCommand,
  );

  router.get('/terminals', guard('terminal:attach'), controller.terminalSessions);
  router.delete('/terminals/:sessionId', guard('terminal:attach'), controller.closeTerminalSession);

  return router;
}
