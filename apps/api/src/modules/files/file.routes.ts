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
 * Room for everything in a file write except the content: the path, the
 * encoding, the expected version and the JSON around them. Generous on purpose,
 * since a path may be up to 1024 characters and each can escape to six bytes.
 */
const WRITE_ENVELOPE_BYTES = 16 * 1024;

/**
 * The largest request body a file write may need.
 *
 * The general JSON limit (1mb) is below what a file of `maxFileBytes` takes as
 * base64, which is a third larger. This is not the file limit itself: the
 * service still refuses decoded content above `maxFileBytes`, with a message
 * that names the limit, which a parser's 413 cannot.
 */
export function fileWriteBodyLimit(maxFileBytes: number): number {
  return Math.ceil(maxFileBytes / 3) * 4 + WRITE_ENVELOPE_BYTES;
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
