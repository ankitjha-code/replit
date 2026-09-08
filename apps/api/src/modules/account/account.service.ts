import type { Logger } from 'pino';
import type { AccountSession } from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import type { PasswordHasher } from '../../lib/password.js';
import type { ProjectRepository } from '../projects/project.repository.js';
import type { ProjectService } from '../projects/project.service.js';
import type { SessionRecord, SessionRepository } from '../sessions/session.repository.js';
import type { UserRepository } from '../users/user.repository.js';

/**
 * What the holder of an account may do to it.
 *
 * Until now an account was something you made and then could not manage: no way
 * to change a password, no way to see where you were signed in, no way to leave.
 * The last of those is the one that matters beyond convenience — an account
 * nobody can close is data somebody cannot get rid of.
 *
 * ## Every operation here re-checks the password
 *
 * A session says who somebody is. It does not say they are still at the
 * keyboard. A borrowed or hijacked session must not be enough to take the
 * account over — and taking it over is what changing a password is — so each of
 * these is proved again with something only the account holder knows.
 *
 * This is also why none of them is a route a project member can reach on behalf
 * of somebody else. There is no administrative path into this file, on purpose.
 */

export interface AccountServiceOptions {
  /** How long a failed check waits, to blunt guessing at an already-open session. */
  wrongPasswordDelayMs: number;
}

export class AccountService {
  /**
   * How a project is deleted properly, set after construction.
   *
   * Optional in the type and required in practice: a deletion that skipped it
   * would leave containers, project databases and stored archives behind while
   * the rows describing them cascaded away — the exact leak the cleanup sweep
   * exists to catch, created deliberately. So it is checked at the moment of
   * use and the deletion refuses rather than proceeding halfway.
   */
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

  /**
   * Changes a password, and optionally ends every other session.
   *
   * The two belong together. A password changed while a stolen session is still
   * open has fixed nothing: whoever holds that session keeps their access and
   * can simply change it again. Offering the sign-out beside the change is what
   * makes the change worth making.
   */
  async changePassword(
    userId: string,
    currentSessionId: string,
    input: { currentPassword: string; newPassword: string; signOutOthers: boolean },
  ): Promise<{ signedOut: number }> {
    const user = await this.users.findById(userId);

    if (!user) {
      // A live session for a user that is gone. Nothing to change, and nothing
      // useful to say about it.
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

    /*
     * Logged as an event worth noticing, without the thing that happened.
     *
     * A password change is the single most useful line in an audit trail after
     * a compromise. Neither password appears here, in any form, which is why
     * this can be logged at all.
     */
    this.log.info({ userId, signedOut }, 'an account password was changed');

    return { signedOut };
  }

  /**
   * Where this account is signed in.
   *
   * Everything a person needs to spot one they do not recognise, and nothing
   * that would let anyone use one. The current session is marked rather than
   * hidden: a list that quietly omitted it would make somebody wonder which
   * entry was them, and guess.
   */
  async listSessions(userId: string, currentSessionId: string): Promise<AccountSession[]> {
    const sessions = await this.sessions.listForUser(userId);
    return sessions.map((session) => summarize(session, currentSessionId));
  }

  /**
   * Ends one session.
   *
   * Ending the current one is allowed. It is a strange thing to do from this
   * page rather than by signing out, but it is not wrong, and the alternative —
   * refusing — would be a rule to explain for no benefit. The controller clears
   * the cookie when the session ended was the one making the request.
   */
  async revokeSession(
    userId: string,
    currentSessionId: string,
    sessionId: string,
  ): Promise<{ wasCurrent: boolean }> {
    const session = await this.sessions.findOwned(sessionId, userId);

    if (!session) {
      /*
       * Not found rather than forbidden.
       *
       * The same rule projects follow: a session belonging to somebody else must
       * not be distinguishable from one that does not exist, or the endpoint
       * becomes a way to confirm identifiers.
       */
      throw new AppError('NOT_FOUND', 'That session no longer exists.', { expose: true });
    }

    await this.sessions.deleteById(sessionId);
    this.log.info({ userId }, 'a session was ended from the account page');

    return { wasCurrent: session.id === currentSessionId };
  }

  /** Ends every session but the one asking. */
  async revokeOtherSessions(userId: string, currentSessionId: string): Promise<number> {
    const signedOut = await this.sessions.deleteAllForUserExcept(userId, currentSessionId);
    this.log.info({ userId, signedOut }, 'other sessions were ended from the account page');
    return signedOut;
  }

  /**
   * Closes the account and everything in it.
   *
   * ## Order is the whole design
   *
   * The `users` row cascades to projects, and projects cascade to nearly
   * everything else. Deleting the user first would therefore *work*, in the
   * sense that no error would be raised and the database would be tidy — while
   * leaving every container running, every project database sitting in another
   * server, and every snapshot in object storage, with nothing left that names
   * any of them.
   *
   * So each owned project is deleted through the service that knows how to
   * release what lives outside this database, and only then does the row go.
   *
   * ## What it does not do
   *
   * Projects this person was a *member* of are untouched. They belong to
   * somebody else, and leaving is not deleting.
   *
   * A project they own that others are members of is deleted, which removes
   * access for those people without asking them. That is a real consequence and
   * the honest one: the alternative is transferring ownership to somebody who
   * did not agree to it.
   */
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

    /*
     * The typed name, checked case-insensitively.
     *
     * This is not a security control — somebody who got this far knows the
     * password. It is the pause between meaning to and doing, and the only
     * protection against an irreversible click. Case is ignored because
     * insisting on it would fail people who meant it.
     */
    if (input.confirmUsername.trim().toLowerCase() !== user.username.toLowerCase()) {
      throw new AppError('VALIDATION_FAILED', 'Type your username exactly to confirm.', {
        expose: true,
        context: { field: 'confirmUsername' },
      });
    }

    if (!this.projectService) {
      /*
       * Refused rather than done partially.
       *
       * Without the project service this would delete the account and silently
       * abandon everything it owned on machines nobody can reach. A person who
       * asked to be forgotten and was told yes deserves that to be true.
       */
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'Accounts cannot be closed on this installation right now.',
        { expose: true },
      );
    }

    const owned = await this.projects.listOwnedIds(userId);

    for (const projectId of owned) {
      /*
       * Failing here stops the whole deletion.
       *
       * Deliberately unlike project deletion itself, which logs a leak and
       * carries on so that one unreachable server cannot make a project
       * undeletable. The reasoning inverts here: there, something remains that
       * names the leak, and the sweep can find it later. Here, the account is
       * about to be removed, and a container abandoned now is one nothing will
       * ever connect back to a person.
       */
      await this.projectService.delete(projectId);
    }

    await this.users.deleteById(userId);

    this.log.info(
      { userId, projectsDeleted: owned.length },
      'an account was closed at its owner’s request',
    );

    return { projectsDeleted: owned.length };
  }

  /**
   * A deliberate wait after a wrong password.
   *
   * These endpoints sit behind a live session, so the usual sign-in limiter does
   * not cover them, and without something here a hijacked session is an
   * unlimited oracle for guessing the password that protects it.
   */
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
