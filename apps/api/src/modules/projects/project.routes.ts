import { Router } from 'express';
import {
  addProjectMemberRequestSchema,
  createProjectRequestSchema,
  updateProjectMemberRequestSchema,
  updateProjectRequestSchema,
} from '@platform/shared';
import { requireAuth } from '../../http/middleware/authenticate.js';
import { requireProjectPermission } from '../../http/middleware/authorize-project.js';
import { rateLimit, type RateLimitStore } from '../../http/middleware/rate-limit.js';
import { validateBody } from '../../http/middleware/validate.js';
import type { AuthorizationService } from './authorization.service.js';
import type { MembershipService } from './membership.service.js';
import { ProjectController } from './project.controller.js';
import type { ProjectRepository } from './project.repository.js';
import type { ProjectService } from './project.service.js';

export interface ProjectRouteOptions {
  projects: ProjectRepository;
  service: ProjectService;
  members: MembershipService;
  authorization: AuthorizationService;
  rateLimitStore: RateLimitStore;
  createMax: number;
  createWindowMs: number;
}

export function projectRoutes(options: ProjectRouteOptions): Router {
  const controller = new ProjectController(options.projects, options.service, options.members);
  const guard = (permission: Parameters<typeof requireProjectPermission>[1]) =>
    requireProjectPermission(options.authorization, permission);

  const router = Router();

  // Applied to the whole router rather than per route. A route added later
  // then cannot be reachable anonymously by omission; forgetting the
  // project-level guard is still possible, but forgetting authentication
  // entirely is not.
  router.use(requireAuth());

  router.post(
    '/',
    // Creation is cheap for the caller and not cheap for us: every project is
    // a row now and a container later.
    rateLimit({
      bucket: 'projects:create',
      store: options.rateLimitStore,
      max: options.createMax,
      windowMs: options.createWindowMs,
    }),
    validateBody(createProjectRequestSchema),
    controller.create,
  );

  // Scoped to the caller by the query, so it needs no project guard: there is
  // no identifier in the request to authorize against.
  router.get('/', controller.list);

  router.get('/:projectId', guard('project:read'), controller.get);
  // The same permission as changing how the project runs: an editor can already
  // change what the project *does*, and renaming it is smaller than that.
  router.patch(
    '/:projectId',
    guard('project:update'),
    validateBody(updateProjectRequestSchema),
    controller.update,
  );
  router.delete('/:projectId', guard('project:delete'), controller.remove);
  router.get('/:projectId/members', guard('member:read'), controller.listMembers);

  /*
   * Managing membership is an owner's job, with one exception below.
   *
   * `member:manage` rather than `project:update`, because changing who can
   * reach a project is a different kind of decision from changing what it is
   * called: one of them can give somebody else a shell inside your container.
   */
  router.post(
    '/:projectId/members',
    guard('member:manage'),
    validateBody(addProjectMemberRequestSchema),
    controller.addMember,
  );

  router.patch(
    '/:projectId/members/:userId',
    guard('member:manage'),
    validateBody(updateProjectMemberRequestSchema),
    controller.setMemberRole,
  );

  /*
   * The exception: leaving.
   *
   * Guarded by `project:read`, which every member holds, and the controller
   * refuses unless the identifier in the path is the caller's own. Leaving is
   * not an administrative act, and having to ask an owner for permission to
   * stop being in a project somebody added you to is the wrong way round.
   */
  router.delete('/:projectId/members/me', guard('project:read'), controller.leave);

  router.delete('/:projectId/members/:userId', guard('member:manage'), controller.removeMember);

  return router;
}
