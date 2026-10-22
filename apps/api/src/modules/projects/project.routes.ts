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

  router.use(requireAuth());

  router.post(
    '/',
    rateLimit({
      bucket: 'projects:create',
      store: options.rateLimitStore,
      max: options.createMax,
      windowMs: options.createWindowMs,
    }),
    validateBody(createProjectRequestSchema),
    controller.create,
  );

  router.get('/', controller.list);

  router.get('/:projectId', guard('project:read'), controller.get);
  router.patch(
    '/:projectId',
    guard('project:update'),
    validateBody(updateProjectRequestSchema),
    controller.update,
  );
  router.delete('/:projectId', guard('project:delete'), controller.remove);
  router.get('/:projectId/members', guard('member:read'), controller.listMembers);

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

  router.delete('/:projectId/members/me', guard('project:read'), controller.leave);

  router.delete('/:projectId/members/:userId', guard('member:manage'), controller.removeMember);

  return router;
}
