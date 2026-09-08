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

/**
 * Mounted under a project, so `:projectId` is already in the path.
 *
 * Reading history needs `version:read`, which a viewer has. Committing needs
 * `version:write`, which an editor has, and which is the same capability that
 * governs snapshots: both are ways of writing down what a project was.
 *
 * The author of a commit is never in the request body. It comes from the
 * signed-in account, because an author line a caller could choose is a
 * signature that means nothing.
 */
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

  /**
   * Puts the project's files back to what a commit contained.
   *
   * Not a checkout. Nothing moves the branch and nothing is detached: the next
   * commit's parent is still the current head, so going back is itself recorded
   * as a step forward. That is a truer history than one which pretends the work
   * in between never happened, and it is the only version of this that a
   * platform storing history separately from files can honestly offer.
   */
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

  /* One file back from a commit. See the snapshot route for why only `file:write`. */
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

  /*
   * Branches.
   *
   * Creating and deleting one is writing history. Switching and merging also
   * rewrite the project's files, so they need file:write as well, like a restore.
   */
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

  /*
   * The remote.
   *
   * Reading it is reading history, and never shows the token. Setting it is the
   * owner's, because it holds a credential; `secret:write` is exactly that
   * capability. Pushing and pulling use the stored credential on behalf of
   * whoever may write history, which is how a team shares one repository.
   */
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

/**
 * The author of anything this request writes into history.
 *
 * Never from the body. The address is on a domain reserved for exactly this:
 * git requires an email, and using the account's real one would write it into
 * an artefact that can be pushed anywhere.
 */
function authorOf(req: Request): { name: string; email: string } {
  const { user } = requireAuthContext(req);
  return {
    name: user.displayName ?? user.username,
    email: `${user.username}@users.noreply.localhost`,
  };
}

/** A branch name from the path, which may contain slashes once decoded. */
function branchParam(req: Request): string {
  const raw: unknown = req.params.name;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new AppError('NOT_FOUND', 'There is no branch with that name');
  }
  return raw;
}
