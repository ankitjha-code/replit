import express, { Router } from 'express';
import { requireProjectPermission } from '../../http/middleware/authorize-project.js';
import type { AuthorizationService } from '../projects/authorization.service.js';
import { AssetController } from './asset.controller.js';
import type { AssetService } from './asset.service.js';

export interface AssetRouteOptions {
  assets: AssetService;
  authorization: AuthorizationService;
  maxAssetBytes: number;
}

/**
 * Mounted under a project, so `:projectId` is already in the path.
 *
 * Reading needs `storage:read`, which a viewer has: someone shown a project
 * can see what belongs to it. Uploading and deleting need `storage:write`.
 */
export function assetRoutes(options: AssetRouteOptions): Router {
  const controller = new AssetController(options.assets);
  const guard = (permission: Parameters<typeof requireProjectPermission>[1]) =>
    requireProjectPermission(options.authorization, permission);

  const router = Router({ mergeParams: true });

  router.get('/', guard('storage:read'), controller.list);
  router.get('/:assetId/content', guard('storage:read'), controller.download);

  router.post(
    '/',
    guard('storage:write'),
    /*
     * Raw bytes, of any declared type, up to the asset ceiling.
     *
     * The limit is enforced here as well as in the service, because this one
     * stops reading at the ceiling while the service can only refuse what has
     * already been held in memory.
     */
    express.raw({ type: () => true, limit: options.maxAssetBytes }),
    controller.upload,
  );

  router.delete('/:assetId', guard('storage:write'), controller.remove);

  return router;
}
