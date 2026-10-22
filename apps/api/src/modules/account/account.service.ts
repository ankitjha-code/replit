import type { Logger } from 'pino';
import type { AccountSession } from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import type { PasswordHasher } from '../../lib/password.js';
import type { ProjectRepository } from '../projects/project.repository.js';
import type { ProjectService } from '../projects/project.service.js';
import type { SessionRecord, SessionRepository } from '../sessions/session.repository.js';
import type { UserRepository } from '../users/user.repository.js';

export interface AccountServiceOptions {
  wrongPasswordDelayMs: number;
}

export class AccountService {
  private projectService?: ProjectService;

  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly projects: ProjectRepository,
    private readonly hasher: PasswordHasher,
    private readonly options: AccountServiceOptions,
    private readonly log: Logger,
  ) {}

  useProjects(projectService: ProjectService): void {
    this.projectService = projectService;
  }

  async changePassword(
    userId: string,
    currentSessionId: string,
    input: { currentPassword: string; newPassword: string; signOutOthers: boolean },
  ): Promise<{ signedOut: number }> {
    const user = await this.users.findById(userId);

    if (!user) {
      throw new AppError('UNAUTHENTICATED', 'Sign in again to continue.', { expose: true });
    }

    if (!(await this.hasher.verify(user.passwordHash, input.currentPassword))) {
      await this.pause();
      throw new AppError('VALIDATION_FAILED', 'That is not your current password.', {
        expose: true,
        context: { field: 'currentPassword' },
      });
    }

    await this.users.updatePasswordHash(userId, await this.hasher.hash(input.newPassword));

    const signedOut = input.signOutOthers
      ? await this.sessions.deleteAllForUserExcept(userId, currentSessionId)
      : 0;

    this.log.info({ userId, signedOut }, 'an account password was changed');

    return { signedOut };
  }

  async listSessions(userId: string, currentSessionId: string): Promise<AccountSession[]> {
    const sessions = await this.sessions.listForUser(userId);
    return sessions.map((session) => summarize(session, currentSessionId));
  }

  async revokeSession(
    userId: string,
    currentSessionId: string,
    sessionId: string,
  ): Promise<{ wasCurrent: boolean }> {
    const session = await this.sessions.findOwned(sessionId, userId);

    if (!session) {
      throw new AppError('NOT_FOUND', 'That session no longer exists.', { expose: true });
    }

    await this.sessions.deleteById(sessionId);
    this.log.info({ userId }, 'a session was ended from the account page');

    return { wasCurrent: session.id === currentSessionId };
  }

  async revokeOtherSessions(userId: string, currentSessionId: string): Promise<number> {
    const signedOut = await this.sessions.deleteAllForUserExcept(userId, currentSessionId);
    this.log.info({ userId, signedOut }, 'other sessions were ended from the account page');
    return signedOut;
  }

  async deleteAccount(
    userId: string,
    input: { password: string; confirmUsername: string },
  ): Promise<{ projectsDeleted: number }> {
    const user = await this.users.findById(userId);

    if (!user) {
      throw new AppError('UNAUTHENTICATED', 'Sign in again to continue.', { expose: true });
    }

    if (!(await this.hasher.verify(user.passwordHash, input.password))) {
      await this.pause();
      throw new AppError('VALIDATION_FAILED', 'That is not your password.', {
        expose: true,
        context: { field: 'password' },
      });
    }

    if (input.confirmUsername.trim().toLowerCase() !== user.username.toLowerCase()) {
      throw new AppError('VALIDATION_FAILED', 'Type your username exactly to confirm.', {
        expose: true,
        context: { field: 'confirmUsername' },
      });
    }

    if (!this.projectService) {
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'Accounts cannot be closed on this installation right now.',
        { expose: true },
      );
    }

    const owned = await this.projects.listOwnedIds(userId);

    for (const projectId of owned) {
      await this.projectService.delete(projectId);
    }

    await this.users.deleteById(userId);

    this.log.info(
      { userId, projectsDeleted: owned.length },
      'an account was closed at its owner’s request',
    );

    return { projectsDeleted: owned.length };
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.options.wrongPasswordDelayMs));
  }
}

function summarize(session: SessionRecord, currentSessionId: string): AccountSession {
  return {
    id: session.id,
    current: session.id === currentSessionId,
    createdAt: session.createdAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    userAgent: session.userAgent,
    ipAddress: session.ipAddress,
  };
}
