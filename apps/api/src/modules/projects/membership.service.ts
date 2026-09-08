import { type ProjectMemberView, type ProjectRole } from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { ProjectEventPublisher } from '../../events/project-event-bus.js';
import type { UserRepository } from '../users/user.repository.js';
import type { ProjectRepository } from './project.repository.js';

/**
 * Who may reach a project, and at what level.
 *
 * Everything built in this phase so far assumed more than one person could be
 * in a project, and nothing could put them there: a project had exactly the
 * members it was created with, which is one. This is the part that makes
 * presence, events and shared editing something other than a description of a
 * situation that cannot arise.
 *
 * Three rules shape the whole file, and each exists because breaking it would
 * be unrecoverable through the API:
 *
 *  1. **A project always has at least one owner.** Removing or demoting the
 *     last one would leave a project nobody can administer and nobody can
 *     delete. It is refused rather than warned about.
 *  2. **Nobody may change their own role.** An owner who could demote
 *     themselves could lock a project by accident; anyone else who could change
 *     their own role would not need this file at all.
 *  3. **Anybody may remove themselves**, except the last owner. Leaving is not
 *     an administrative act, and needing an owner's help to stop being in a
 *     project you were added to is the wrong way round.
 */
export class MembershipService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly users: UserRepository,
    private readonly log: Logger,
  ) {}

  /**
   * Where membership changes are announced, when there is anywhere to announce
   * them. Set after construction, as the file service's is.
   */
  private events: ProjectEventPublisher | undefined;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }

  async list(projectId: string): Promise<ProjectMemberView[]> {
    const members = await this.projects.listMembers(projectId);
    return members.map(toView);
  }

  /**
   * Adds somebody by username.
   *
   * By username rather than by identifier, because a username is the only thing
   * about another account a person can be expected to know and the only thing
   * the platform ever shows them. Accepting an identifier here would imply a
   * way to look one up, which is a way to enumerate accounts.
   *
   * An unknown username and an existing member are told apart, and that is a
   * deliberate disclosure: the caller is an owner asking about a person they
   * named, and "there is no such account" is the only answer that lets them
   * correct a typo. It leaks that a username exists, which the registration
   * form already reveals by refusing to reuse one.
   */
  async add(
    projectId: string,
    actorId: string,
    input: { username: string; role: ProjectRole },
  ): Promise<ProjectMemberView> {
    const user = await this.users.findByUsername(input.username.trim().toLowerCase());

    if (!user) {
      throw new AppError('NOT_FOUND', 'There is no account with that username', {
        details: { fields: [{ path: 'username', message: 'No account with that username' }] },
      });
    }

    const existing = await this.projects.findMembership(projectId, user.id);
    if (existing) {
      throw new AppError('CONFLICT', 'That person is already in this project', {
        details: { field: 'username' },
      });
    }

    const membership = await this.projects.upsertMembership(projectId, user.id, input.role);

    this.log.info(
      { projectId, actorId, userId: user.id, role: input.role },
      'project member added',
    );
    this.announce(projectId, user.id);

    return {
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      role: membership.role,
      joinedAt: membership.createdAt.toISOString(),
    };
  }

  /** Changes somebody's role. */
  async setRole(
    projectId: string,
    actorId: string,
    userId: string,
    role: ProjectRole,
  ): Promise<ProjectMemberView> {
    if (userId === actorId) {
      /*
       * Refused rather than allowed-with-a-warning.
       *
       * An owner demoting themselves in a project where they are the only owner
       * produces a project nobody can administer, and the check that would
       * prevent that is the same check as this one with an extra case. One rule
       * is easier to be sure of than two.
       */
      throw new AppError('PRECONDITION_FAILED', 'You cannot change your own access.');
    }

    const membership = await this.projects.findMembership(projectId, userId);
    if (!membership) throw new AppError('NOT_FOUND', 'That person is not in this project');

    if (membership.role === 'OWNER' && role !== 'OWNER') {
      await this.requireAnotherOwner(projectId, userId);
    }

    const updated = await this.projects.upsertMembership(projectId, userId, role);
    const user = await this.users.findById(userId);

    this.log.info({ projectId, actorId, userId, role }, 'project member role changed');
    this.announce(projectId, userId);

    return {
      userId,
      // The account exists: it has a membership row that was just updated. The
      // fallbacks are here because a deletion racing this read is representable
      // and returning a half-built object beats throwing over a name.
      username: user?.username ?? '',
      displayName: user?.displayName ?? null,
      role: updated.role,
      joinedAt: updated.createdAt.toISOString(),
    };
  }

  /**
   * Removes somebody, or lets them remove themselves.
   *
   * The caller's permission is checked at the route: `member:manage` for
   * removing anybody, and nothing beyond membership for leaving. The rule that
   * cannot move to the route is the last-owner one, because it needs to count.
   */
  async remove(projectId: string, actorId: string, userId: string): Promise<void> {
    const membership = await this.projects.findMembership(projectId, userId);
    if (!membership) throw new AppError('NOT_FOUND', 'That person is not in this project');

    if (membership.role === 'OWNER') {
      await this.requireAnotherOwner(projectId, userId);
    }

    await this.projects.removeMembership(projectId, userId);

    this.log.info(
      { projectId, actorId, userId, self: actorId === userId },
      actorId === userId ? 'member left project' : 'project member removed',
    );
    this.announce(projectId, userId);
  }

  // -------------------------------------------------------------------------

  /**
   * Refuses when the named owner is the only one.
   *
   * A project with no owner cannot be administered and cannot be deleted, so
   * there is no way back from it through the API. Counting rather than trusting
   * the project's `ownerId` column: that column says who created it, and
   * ownership is a membership.
   */
  private async requireAnotherOwner(projectId: string, userId: string): Promise<void> {
    const owners = await this.projects.countOwners(projectId);
    if (owners > 1) return;

    throw new AppError(
      'PRECONDITION_FAILED',
      'This is the last owner of the project. Make somebody else an owner first.',
      { context: { projectId, userId } },
    );
  }

  /**
   * Tells the project that its membership changed.
   *
   * Carries the affected account, because the sockets that person is holding
   * were authorized under the access they had a moment ago. A gateway that sees
   * this closes them, and their client reconnects and is authorized again from
   * scratch: a role is decided at upgrade, so the only honest way to apply a
   * new one is a new upgrade.
   */
  private announce(projectId: string, userId: string): void {
    this.events?.publish(projectId, { type: 'members.changed', userId });
  }
}

function toView(member: {
  userId: string;
  role: ProjectRole;
  createdAt: Date;
  user: { username: string; displayName: string | null };
}): ProjectMemberView {
  return {
    userId: member.userId,
    username: member.user.username,
    displayName: member.user.displayName,
    role: member.role,
    joinedAt: member.createdAt.toISOString(),
  };
}
