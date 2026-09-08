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

/**
 * Mounted under a project, so `:projectId` is already in the path.
 *
 * Reading the state needs `runtime:read`, which a viewer has: someone shown a
 * project should be able to see whether it is running. Changing it needs
 * `runtime:control`, which a viewer does not, because starting a container
 * spends the host's resources.
 */
export function runtimeRoutes(options: RuntimeRouteOptions): Router {
  const controller = new RuntimeController(options.runtimes, options.runs, options.terminals);
  const guard = (permission: Parameters<typeof requireProjectPermission>[1]) =>
    requireProjectPermission(options.authorization, permission);

  const router = Router({ mergeParams: true });

  // Starting and stopping are the most expensive things a request can ask
  // for, and a start/stop loop is how one account degrades the host for
  // everyone on it.
  const control = rateLimit({
    bucket: 'runtime:control',
    store: options.rateLimitStore,
    max: options.controlMax,
    windowMs: options.controlWindowMs,
    // Per account rather than per address. The cost is borne by the host on
    // behalf of one project's owner, and several people behind one office
    // address should not share a budget.
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

  // Writing files, not controlling a runtime: this changes the project, and
  // the permission that governs that is the one that should be asked for.
  router.post('/sync', guard('file:write'), control, controller.sync);

  /*
   * The project's own application.
   *
   * Reading needs `runtime:read`, which a viewer has: seeing whether a project
   * is up, and what it printed, is part of being shown it. Starting and
   * stopping need `runtime:control`, and setting the command needs
   * `project:update`, because it changes the project rather than a container.
   */
  router.get('/run', guard('runtime:read'), controller.run);
  router.post('/run/start', guard('runtime:control'), control, controller.startRun);
  router.post('/run/stop', guard('runtime:control'), control, controller.stopRun);
  router.put(
    '/run/command',
    guard('project:update'),
    validateBody(setRunCommandRequestSchema),
    controller.setRunCommand,
  );

  /*
   * Open shells.
   *
   * Both need `terminal:attach`, the same capability the socket needs. Being
   * able to see that a shell exists and being able to type into it are the
   * same privilege in practice: the list is only ever the caller's own, and
   * what it is for is getting back to one.
   */
  router.get('/terminals', guard('terminal:attach'), controller.terminalSessions);
  router.delete('/terminals/:sessionId', guard('terminal:attach'), controller.closeTerminalSession);

  return router;
}
