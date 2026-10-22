import type { Request, Response } from 'express';
import {
  permissionsForRole,
  type AddProjectMemberRequest,
  type CreateProjectRequest,
  type ProjectListResponse,
  type ProjectMemberResponse,
  type ProjectMembersResponse,
  type ProjectResponse,
  type UpdateProjectMemberRequest,
  type UpdateProjectRequest,
} from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import { requireAuthContext } from '../../http/middleware/authenticate.js';
import { requireProjectAccess } from '../../http/middleware/authorize-project.js';
import type { MembershipService } from './membership.service.js';
import type { ProjectRepository } from './project.repository.js';
import { toSummary, type ProjectService } from './project.service.js';

/**
 * Translates between HTTP and the project services.
 *
 * Handlers on project-scoped routes perform no access check of their own: by
 * the time one runs, the guard has already resolved the caller's role or
 * refused the request.
 */
export class ProjectController {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly service: ProjectService,
    private readonly members: MembershipService,
  ) {}

  create = async (req: Request, res: Response): Promise<void> => {
    const { user } = requireAuthContext(req);
    const project = await this.service.create(user.id, req.body as CreateProjectRequest);

    const body: ProjectResponse = { project };
    res.status(201).location(`/api/projects/${project.id}`).json(body);
  };

  /**
   * Every project the caller can reach, owned or shared.
   *
   * Scoped by membership in the query itself rather than fetched and filtered,
   * so a project they cannot see never enters the process.
   */
  list = async (req: Request, res: Response): Promise<void> => {
    const { user } = requireAuthContext(req);
    const body: ProjectListResponse = { projects: await this.service.listForUser(user.id) };
    res.status(200).json(body);
  };

  get = (req: Request, res: Response): void => {
    const { project, role } = requireProjectAccess(req);
    const body: ProjectResponse = { project: toSummary(project, role) };
    res.status(200).json(body);
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const { project, role } = requireProjectAccess(req);
    const updated = await this.service.update(project.id, req.body as UpdateProjectRequest);
    const body: ProjectResponse = { project: toSummary(updated, role) };
    res.status(200).json(body);
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    await this.service.delete(project.id);
    res.status(204).end();
  };

  listMembers = async (req: Request, res: Response): Promise<void> => {
    const { project, role } = requireProjectAccess(req);

    const body: ProjectMembersResponse = {
      members: await this.members.list(project.id),
      // Derived from the caller's own role on the server. The client is never
      // asked what it thinks it may do.
      viewerPermissions: permissionsForRole(role),
    };

    res.status(200).json(body);
  };

  addMember = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const { user } = requireAuthContext(req);
    const input = req.body as AddProjectMemberRequest;

    const body: ProjectMemberResponse = {
      member: await this.members.add(project.id, user.id, input),
    };
    res.status(201).json(body);
  };

  setMemberRole = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const { user } = requireAuthContext(req);
    const { role } = req.body as UpdateProjectMemberRequest;

    const body: ProjectMemberResponse = {
      member: await this.members.setRole(project.id, user.id, memberIdFrom(req), role),
    };
    res.status(200).json(body);
  };

  removeMember = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const { user } = requireAuthContext(req);

    await this.members.remove(project.id, user.id, memberIdFrom(req));
    res.status(204).end();
  };

  /**
   * Removes the caller from the project.
   *
   * A separate route behind a weaker guard, so it is impossible for it to
   * become a way to remove somebody else: there is no identifier in the path to
   * get wrong. The last owner is still refused, by the service.
   */
  leave = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const { user } = requireAuthContext(req);

    await this.members.remove(project.id, user.id, user.id);
    res.status(204).end();
  };
}

/** The account a member route names, or a not-found. */
function memberIdFrom(req: Request): string {
  const raw = req.params.userId;
  // Express types a route parameter as possibly repeated. A repeated one is not
  // an account identifier.
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new AppError('NOT_FOUND', 'That person is not in this project');
  }
  return raw;
}
