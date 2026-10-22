import { roleHasPermission, type ProjectPermission, type ProjectRole } from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import type { MembershipRecord, ProjectRecord, ProjectRepository } from './project.repository.js';

export interface ProjectAccess {
  project: ProjectRecord;
  membership: MembershipRecord;
  role: ProjectRole;
}

export class AuthorizationService {
  constructor(private readonly projects: ProjectRepository) {}

  async authorize(
    userId: string,
    projectId: string,
    permission: ProjectPermission,
  ): Promise<ProjectAccess> {
    const found = await this.projects.findWithMembership(projectId, userId);

    if (!found || !found.membership) {
      throw notFound();
    }

    const { project, membership } = found;

    if (!roleHasPermission(membership.role, permission)) {
      throw new AppError('FORBIDDEN', 'Your access to this project does not allow that', {
        details: { required: permission, role: membership.role },
        context: { projectId, userId },
      });
    }

    return { project, membership, role: membership.role };
  }

  async can(userId: string, projectId: string, permission: ProjectPermission): Promise<boolean> {
    const membership = await this.projects.findMembership(projectId, userId);
    return membership !== null && roleHasPermission(membership.role, permission);
  }
}

const notFound = (): AppError => new AppError('NOT_FOUND', 'Project not found');
