import { Router, type Request, type Response } from 'express';
import {
  createBranchRequestSchema,
  mergeBranchRequestSchema,
  pushRequestSchema,
  setGitRemoteRequestSchema,
  type CreateBranchRequest,
  type MergeBranchRequest,
  type PushRequest,
  type SetGitRemoteRequest,
  restoreFileRequestSchema,
  type RestoreFileResponse,
  commitRequestSchema,
  type GitCommitDetailResponse,
  type GitStateResponse,
  type RestoreResponse,
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
import type { GitService } from './git.service.js';

export function gitRoutes(options: {
  git: GitService;
  restore: RestoreService;
  authorization: AuthorizationService;
}): Router {
  const guard = (permission: Parameters<typeof requireProjectPermission>[1]) =>
    requireProjectPermission(options.authorization, permission);

  const router = Router({ mergeParams: true });

  router.get('/', guard('version:read'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);
    const body: GitStateResponse = await options.git.describe(project.id);
    res.status(200).json(body);
  });

  router.post(
    '/commits',
    guard('version:write'),
    validateBody(commitRequestSchema),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const input = req.body as { message: string };

      const body: GitStateResponse = await options.git.commit(
        project.id,
        authorOf(req),
        input.message,
      );

      res.status(201).json(body);
    },
  );

  router.post(
    '/commits/:oid/restore',
    guard('version:write'),
    guard('file:write'),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const { user } = requireAuthContext(req);
      const oid = req.params.oid;

      if (typeof oid !== 'string') {
        throw new AppError('NOT_FOUND', 'There is no commit with that identifier');
      }

      const body: RestoreResponse = {
        restore: await options.restore.fromCommit(project.id, user.id, oid),
      };
      res.status(200).json(body);
    },
  );

  router.post(
    '/commits/:oid/restore-file',
    guard('file:write'),
    validateBody(restoreFileRequestSchema),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const oid = req.params.oid;
      if (typeof oid !== 'string') {
        throw new AppError('NOT_FOUND', 'There is no commit with that identifier');
      }

      const { path } = req.body as { path: string };
      const body: RestoreFileResponse = await options.restore.restoreFile(
        project.id,
        { kind: 'commit', oid },
        path,
      );
      res.status(200).json(body);
    },
  );

  router.post(
    '/branches',
    guard('version:write'),
    validateBody(createBranchRequestSchema),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const { name, from } = req.body as CreateBranchRequest;
      res.status(201).json(await options.git.createBranch(project.id, name, from));
    },
  );

  router.delete('/branches/:name', guard('version:write'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);
    res.status(200).json(await options.git.deleteBranch(project.id, branchParam(req)));
  });

  router.post(
    '/branches/:name/switch',
    guard('version:write'),
    guard('file:write'),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      res.status(200).json(await options.restore.switchBranch(project.id, branchParam(req)));
    },
  );

  router.post(
    '/merge',
    guard('version:write'),
    guard('file:write'),
    validateBody(mergeBranchRequestSchema),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const { branch } = req.body as MergeBranchRequest;
      res.status(200).json(await options.restore.mergeBranch(project.id, branch, authorOf(req)));
    },
  );

  router.get('/remote', guard('version:read'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);
    res.status(200).json({ remote: await options.git.remote(project.id) });
  });

  router.put(
    '/remote',
    guard('secret:write'),
    validateBody(setGitRemoteRequestSchema),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const remote = await options.git.setRemote(project.id, req.body as SetGitRemoteRequest);
      res.status(200).json({ remote });
    },
  );

  router.delete('/remote', guard('secret:write'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);
    await options.git.removeRemote(project.id);
    res.status(204).end();
  });

  router.post(
    '/push',
    guard('version:write'),
    validateBody(pushRequestSchema),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const { force } = req.body as PushRequest;
      res.status(200).json(await options.git.push(project.id, force));
    },
  );

  router.post(
    '/pull',
    guard('version:write'),
    guard('file:write'),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      res.status(200).json(await options.restore.pull(project.id, authorOf(req)));
    },
  );

  router.get('/commits/:oid', guard('version:read'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);
    const oid = req.params.oid;

    if (typeof oid !== 'string') {
      throw new AppError('NOT_FOUND', 'There is no commit with that identifier');
    }

    const body: GitCommitDetailResponse = await options.git.show(project.id, oid);
    res.status(200).json(body);
  });

  return router;
}

function authorOf(req: Request): { name: string; email: string } {
  const { user } = requireAuthContext(req);
  return {
    name: user.displayName ?? user.username,
    email: `${user.username}@users.noreply.localhost`,
  };
}

function branchParam(req: Request): string {
  const raw: unknown = req.params.name;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new AppError('NOT_FOUND', 'There is no branch with that name');
  }
  return raw;
}
