import { Router } from 'express';
import {
  createDirectoryRequestSchema,
  movePathRequestSchema,
  writeFileRequestSchema,
} from '@platform/shared';
import { requireProjectPermission } from '../../http/middleware/authorize-project.js';
import { validateBody } from '../../http/middleware/validate.js';
import type { AuthorizationService } from '../projects/authorization.service.js';
import { FileController } from './file.controller.js';
import type { FileService } from './file.service.js';

export interface FileRouteOptions {
  files: FileService;
  authorization: AuthorizationService;
}

/**
 * Mounted under a project, so `:projectId` is already in the path.
 *
 * Reading needs `file:read`, which a viewer has. Every change needs
 * `file:write`, which a viewer does not: someone shown a project must not be
 * able to alter it.
 */
export function fileRoutes(options: FileRouteOptions): Router {
  const controller = new FileController(options.files);
  const guard = (permission: Parameters<typeof requireProjectPermission>[1]) =>
    requireProjectPermission(options.authorization, permission);

  // mergeParams, or :projectId from the parent router would not be visible to
  // the guard that needs it.
  const router = Router({ mergeParams: true });

  router.get('/', guard('file:read'), controller.tree);
  router.get('/content', guard('file:read'), controller.read);
  router.get('/search', guard('file:read'), controller.search);

  router.put(
    '/content',
    guard('file:write'),
    validateBody(writeFileRequestSchema),
    controller.write,
  );
  router.post(
    '/directory',
    guard('file:write'),
    validateBody(createDirectoryRequestSchema),
    controller.createDirectory,
  );
  router.post('/move', guard('file:write'), validateBody(movePathRequestSchema), controller.move);
  router.delete('/', guard('file:write'), controller.remove);

  return router;
}
