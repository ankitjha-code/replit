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

/**
 * Mounted under a project, so `:projectId` is already in the path.
 *
 * Both routes need an owner. There is nothing useful to show about a database
 * without its connection details, and those are a live credential, so reading
 * and managing are one capability rather than two: an editor can change what a
 * project does and still cannot reach its data directly.
 *
 * Creating is a POST to a named sub-resource rather than a PUT of the whole
 * thing. It is not idempotent in the way a PUT promises: asking twice is
 * refused, because a second database would leave the first holding the only
 * copy of data nobody can reach any more.
 */
export function databaseRoutes(options: {
  databases: DatabaseService;
  backups: BackupService;
  runtimes: RuntimeService;
  authorization: AuthorizationService;
}): Router {
  const guard = (permission: Parameters<typeof requireProjectPermission>[1]) =>
    requireProjectPermission(options.authorization, permission);

  const router = Router({ mergeParams: true });

  /**
   * Whether what is described is what the running application is using.
   *
   * A container is handed its environment when it is created, so a reset or a
   * rotation changes the next start rather than the current one. After a
   * rotation the credentials a running container holds do not merely differ,
   * they no longer work.
   */
  const restartRequired = async (projectId: string): Promise<boolean> => {
    const runtime = await options.runtimes.describe(projectId);
    return runtime.runtime?.status === 'RUNNING';
  };

  router.get('/', guard('database:read'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);

    // The permission was checked by the guard above, so the credential may be
    // included. The service is told rather than left to work it out from a role.
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

  /*
   * Emptying, changing the password, and removing.
   *
   * All three are POSTs to named sub-resources rather than verbs on the
   * collection, because none of them is idempotent in the way a PUT promises
   * and each destroys something different: a reset destroys the data, a
   * rotation destroys the old credential, and a delete destroys both.
   */
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

  /*
   * Backups sit under the database and need the same permission as managing it.
   *
   * Reading the list is `database:read` — knowing that a copy exists is not the
   * same as having it — and everything else is `database:manage`, because taking
   * a copy runs a container and putting one back destroys data.
   *
   * There is deliberately **no download route**. A dump is the whole contents of
   * somebody's database in one file; an endpoint that handed one over would be
   * the most valuable thing to reach on this platform. A backup exists to be
   * restored here.
   */
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
