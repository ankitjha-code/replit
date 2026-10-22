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
    express.raw({ type: () => true, limit: options.maxAssetBytes }),
    controller.upload,
  );

  router.delete('/:assetId', guard('storage:write'), controller.remove);

  return router;
}
