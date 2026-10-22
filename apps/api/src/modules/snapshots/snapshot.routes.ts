import { Router, type Request, type Response } from 'express';
import {
  restoreFileRequestSchema,
  type RestoreFileResponse,
  createSnapshotRequestSchema,
  type RestoreResponse,
  type SnapshotListResponse,
} from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import { requireAuthContext } from '../../http/middleware/authenticate.js';
import {
  requireProjectPermission,
  requireProjectAccess,
} from '../../http/middleware/authorize-project.js';
import { validateBody } from '../../http/middleware/validate.js';
import type { AuthorizationService } from '../projects/authorization.service.js';
import type { RestoreService } from '../restore/restore.service.js';
import type { SnapshotService } from './snapshot.service.js';

export function snapshotRoutes(options: {
  snapshots: SnapshotService;
  restore: RestoreService;
  authorization: AuthorizationService;
}): Router {
  const guard = (permission: Parameters<typeof requireProjectPermission>[1]) =>
    requireProjectPermission(options.authorization, permission);

  const router = Router({ mergeParams: true });

  router.get('/', guard('version:read'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);

    const body: SnapshotListResponse = {
      snapshots: await options.snapshots.list(project.id),
      limit: options.snapshots.limit,
      unavailableReason: await options.snapshots.unavailableReason(),
    };
    res.status(200).json(body);
  });

  router.post(
    '/',
    guard('version:write'),
    validateBody(createSnapshotRequestSchema),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const { user } = requireAuthContext(req);
      const input = req.body as { name: string; description?: string };

      const snapshot = await options.snapshots.create(project.id, user.id, input);
      res.status(201).json({ snapshot });
    },
  );

  router.get('/:snapshotId/archive', guard('version:read'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);
    const snapshotId = req.params.snapshotId;

    if (typeof snapshotId !== 'string') {
      throw new AppError('NOT_FOUND', 'There is no snapshot with that identifier');
    }

    const { record, archive } = await options.snapshots.read(project.id, snapshotId);

    res.status(200);
    res.setHeader('content-type', 'application/x-tar');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-disposition', `attachment; filename="snapshot-${record.id}.tar"`);
    res.send(archive);
  });

  router.post(
    '/:snapshotId/restore',
    guard('version:write'),
    guard('file:write'),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const { user } = requireAuthContext(req);
      const snapshotId = req.params.snapshotId;

      if (typeof snapshotId !== 'string') {
        throw new AppError('NOT_FOUND', 'There is no snapshot with that identifier');
      }

      const body: RestoreResponse = {
        restore: await options.restore.fromSnapshot(project.id, user.id, snapshotId),
      };
      res.status(200).json(body);
    },
  );

  router.post(
    '/:snapshotId/restore-file',
    guard('file:write'),
    validateBody(restoreFileRequestSchema),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const snapshotId = req.params.snapshotId;
      if (typeof snapshotId !== 'string') {
        throw new AppError('NOT_FOUND', 'There is no snapshot with that identifier');
      }

      const { path } = req.body as { path: string };
      const body: RestoreFileResponse = await options.restore.restoreFile(
        project.id,
        { kind: 'snapshot', id: snapshotId },
        path,
      );
      res.status(200).json(body);
    },
  );

  router.delete('/:snapshotId', guard('version:write'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);
    const snapshotId = req.params.snapshotId;

    if (typeof snapshotId !== 'string') {
      throw new AppError('NOT_FOUND', 'There is no snapshot with that identifier');
    }

    await options.snapshots.remove(project.id, snapshotId);
    res.status(204).end();
  });

  return router;
}
