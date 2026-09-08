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

/**
 * Mounted under a project, so `:projectId` is already in the path.
 *
 * Reading needs `version:read`, which a viewer has: somebody shown a project
 * should be able to see that its history exists. Taking and discarding need
 * `version:write`, which an editor has, because both spend the platform's
 * storage and discarding one destroys something nothing else holds.
 *
 * There is no route that changes a snapshot. A snapshot that could be edited is
 * not a record of anything, so the absence is the design.
 *
 * Restoring needs both `version:write` and `file:write`, checked separately. The
 * same role holds them today, and stating both is what keeps that a fact about
 * the roles rather than an assumption in this file: a restore reads history and
 * rewrites a project's source, and either capability alone should not be enough.
 */
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

  /**
   * The archive itself.
   *
   * Served as a download and never rendered, for the same reason a project's
   * assets are: these are bytes a person put there, and the platform's origin
   * is not somewhere they should ever run.
   */
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
    // The name is generated from the identifier, not from what the snapshot was
    // called: a filename built from user input is a filename built from user
    // input, wherever it ends up.
    res.setHeader('content-disposition', `attachment; filename="snapshot-${record.id}.tar"`);
    res.send(archive);
  });

  /**
   * Puts every file in the project back to what this snapshot holds.
   *
   * Destructive and deliberately so, which is why it is a POST to its own path
   * rather than something a GET could ever be mistaken for. The platform takes a
   * snapshot of what is there first, and the response says which one, so the
   * client can offer the way back without having to go looking for it.
   */
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

  /*
   * One file back from a snapshot.
   *
   * `file:write` only, not `version:write`: nothing about the snapshots
   * changes, and putting one file back is an edit — the same permission saving
   * needs, and like saving it works while the project is running.
   */
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
