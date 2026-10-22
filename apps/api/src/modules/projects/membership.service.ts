import { type ProjectMemberView, type ProjectRole } from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { ProjectEventPublisher } from '../../events/project-event-bus.js';
import type { UserRepository } from '../users/user.repository.js';
import type { ProjectRepository } from './project.repository.js';

export class MembershipService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly users: UserRepository,
    private readonly log: Logger,
  ) {}

  private events: ProjectEventPublisher | undefined;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }

  async list(projectId: string): Promise<ProjectMemberView[]> {
    const members = await this.projects.listMembers(projectId);
    return members.map(toView);
  }

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

  async setRole(
    projectId: string,
    actorId: string,
    userId: string,
    role: ProjectRole,
  ): Promise<ProjectMemberView> {
    if (userId === actorId) {
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
      username: user?.username ?? '',
      displayName: user?.displayName ?? null,
      role: updated.role,
      joinedAt: updated.createdAt.toISOString(),
    };
  }

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

  private async requireAnotherOwner(projectId: string, userId: string): Promise<void> {
    const owners = await this.projects.countOwners(projectId);
    if (owners > 1) return;

    throw new AppError(
      'PRECONDITION_FAILED',
      'This is the last owner of the project. Make somebody else an owner first.',
      { context: { projectId, userId } },
    );
  }

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
