import { Router, type Request, type Response } from 'express';
import {
  createBackupRequestSchema,
  restoreBackupRequestSchema,
  type DatabaseBackupSummary,
  type DatabaseStateResponse,
} from '@platform/shared';
import {
  requireProjectPermission,
  requireProjectAccess,
} from '../../http/middleware/authorize-project.js';
import { requireAuthContext } from '../../http/middleware/authenticate.js';
import type { AuthorizationService } from '../projects/authorization.service.js';
import type { RuntimeService } from '../runtimes/runtime.service.js';
import { validateBody } from '../../http/middleware/validate.js';
import { AppError } from '../../errors/app-error.js';
import type { BackupService } from './backup.service.js';
import type { DatabaseService } from './database.service.js';

export function databaseRoutes(options: {
  databases: DatabaseService;
  backups: BackupService;
  runtimes: RuntimeService;
  authorization: AuthorizationService;
}): Router {
  const guard = (permission: Parameters<typeof requireProjectPermission>[1]) =>
    requireProjectPermission(options.authorization, permission);

  const router = Router({ mergeParams: true });

  const restartRequired = async (projectId: string): Promise<boolean> => {
    const runtime = await options.runtimes.describe(projectId);
    return runtime.runtime?.status === 'RUNNING';
  };

  router.get('/', guard('database:read'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);

    const body: DatabaseStateResponse = await options.databases.describe(project.id, {
      includeConnection: true,
      restartRequired: await restartRequired(project.id),
    });
    res.status(200).json(body);
  });

  router.post('/', guard('database:manage'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);
    const body: DatabaseStateResponse = await options.databases.provision(project.id);
    res.status(201).json(body);
  });

  router.post('/reset', guard('database:manage'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);
    const state = await options.databases.reset(project.id);
    res.status(200).json({ ...state, restartRequired: await restartRequired(project.id) });
  });

  router.post('/rotate', guard('database:manage'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);
    const state = await options.databases.rotate(project.id);
    res.status(200).json({ ...state, restartRequired: await restartRequired(project.id) });
  });

  router.delete('/', guard('database:manage'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);
    const state = await options.databases.destroy(project.id);
    res.status(200).json({ ...state, restartRequired: await restartRequired(project.id) });
  });

  router.get('/backups', guard('database:read'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);

    const body: { backups: DatabaseBackupSummary[] } = {
      backups: await options.backups.list(project.id),
    };
    res.status(200).json(body);
  });

  router.post(
    '/backups',
    guard('database:manage'),
    validateBody(createBackupRequestSchema),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const { user } = requireAuthContext(req);

      const database = await options.databases.connectionForBackup(project.id);
      if (!database) {
        throw new AppError('PRECONDITION_FAILED', 'This project has no database to copy.', {
          expose: true,
        });
      }

      const backup = await options.backups.create(
        project.id,
        database,
        user.id,
        req.body as { note?: string | undefined },
      );
      res.status(201).json({ backup });
    },
  );

  router.post(
    '/backups/:backupId/restore',
    guard('database:manage'),
    validateBody(restoreBackupRequestSchema),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);

      const raw: unknown = req.params.backupId;
      const backupId = typeof raw === 'string' ? raw : undefined;
      if (!backupId) throw new AppError('VALIDATION_FAILED', 'No backup was named.');

      const database = await options.databases.connectionForBackup(project.id);
      if (!database) {
        throw new AppError('PRECONDITION_FAILED', 'This project has no database to restore into.', {
          expose: true,
        });
      }

      await options.backups.restore(project.id, backupId, database.connectionUrl);
      res.status(204).end();
    },
  );

  router.delete('/backups/:backupId', guard('database:manage'), async (req, res: Response) => {
    const { project } = requireProjectAccess(req);

    const raw: unknown = req.params.backupId;
    const backupId = typeof raw === 'string' ? raw : undefined;
    if (!backupId) throw new AppError('VALIDATION_FAILED', 'No backup was named.');

    await options.backups.remove(project.id, backupId);
    res.status(204).end();
  });

  return router;
}
