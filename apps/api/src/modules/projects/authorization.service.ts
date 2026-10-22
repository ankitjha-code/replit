import { roleHasPermission, type ProjectPermission, type ProjectRole } from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import type { MembershipRecord, ProjectRecord, ProjectRepository } from './project.repository.js';

/**
 * The single gate for project-scoped access.
 *
 * Every request that touches a project passes through here. There is no
 * "internal" path that skips it, and no caller anywhere is trusted to have
 * checked already: the frontend imports the same permission table only to
 * decide what to render.
 */

export interface ProjectAccess {
  project: ProjectRecord;
  membership: MembershipRecord;
  role: ProjectRole;
}

export class AuthorizationService {
  constructor(private readonly projects: ProjectRepository) {}

  /**
   * Resolves a user's access to a project, or refuses.
   *
   * The distinction between the two refusals is deliberate and is the whole
   * security-relevant decision in this file:
   *
   *  - **Not a member, or no such project: 404.** These answer identically on
   *    purpose. A 403 would confirm the project exists, which lets anyone walk
   *    identifiers and learn what other people are working on. A stranger
   *    should not be able to tell an unreachable project from an absent one.
   *  - **A member without the capability: 403.** They already know it exists,
   *    so there is nothing left to hide, and a 404 here would be actively
   *    misleading: it would say "no such project" to someone looking at it.
   */
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

  /**
   * Whether a user could do something, without throwing.
   *
   * For deciding what to include in a response, not for guarding an action.
   * Guarding uses `authorize`, so a missed check is a thrown error rather than
   * a forgotten `if`.
   */
  async can(userId: string, projectId: string, permission: ProjectPermission): Promise<boolean> {
    const membership = await this.projects.findMembership(projectId, userId);
    return membership !== null && roleHasPermission(membership.role, permission);
  }
}

/**
 * The answer for both "no such project" and "not yours".
 *
 * Written once so the two cannot drift apart into distinguishable responses.
 */
const notFound = (): AppError => new AppError('NOT_FOUND', 'Project not found');
