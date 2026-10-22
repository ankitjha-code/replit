import { randomBytes } from 'node:crypto';
import { identifierIsEmail, normalizeEmail, type LoginRequest } from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { PasswordHasher } from '../../lib/password.js';
import type { UserRecord, UserRepository } from '../users/user.repository.js';
import type { IssuedSession, RequestFingerprint, SessionService } from './session.service.js';

/**
 * Credential verification and sign-in.
 *
 * Two properties are non-negotiable here and shape most of the code:
 *
 *  - **One answer for every failure.** Wrong password, unknown account and
 *    unknown username all produce the same message and the same status. Any
 *    difference turns sign-in into an oracle for which accounts exist.
 *  - **One cost for every failure.** A missing account must take about as long
 *    as a wrong password, or the timing tells an attacker what the message
 *    refuses to.
 */

export interface LoginResult {
  user: UserRecord;
  issued: IssuedSession;
}

/**
 * What a password alone gets, for an account with a second factor: a challenge
 * to answer with a code, and no session.
 */
export interface ChallengeResult {
  user: UserRecord;
  challenge: string;
}

export class AuthenticationService {
  /**
   * A real hash of a value nobody knows, verified against when no account
   * matches so the two paths cost the same.
   *
   * Produced by the configured hasher rather than written as a literal, so it
   * always carries the current parameters and is always genuinely parseable.
   * A hand-written constant that failed to parse would return immediately,
   * which is exactly the timing signal this exists to remove.
   *
   * Computed once, lazily, and shared: it is not a secret, only a workload.
   */
  private absentUserHash: Promise<string> | undefined;

  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionService,
    private readonly hasher: PasswordHasher,
    private readonly log: Logger,
  ) {}

  /**
   * The second factor, when there is one.
   *
   * Set after construction, like every optional collaborator here. Absent means
   * a password is all sign-in asks for, which is also what an account without a
   * second factor gets.
   */
  private twoFactor?: {
    isEnabled(userId: string): Promise<boolean>;
    createChallenge(userId: string, email: string): Promise<string>;
    completeChallenge(challenge: string, code: string): Promise<string>;
  };

  useTwoFactor(twoFactor: NonNullable<typeof this.twoFactor>): void {
    this.twoFactor = twoFactor;
  }

  private decoyHash(): Promise<string> {
    this.absentUserHash ??= this.hasher.hash(randomBytes(32).toString('base64url'));
    return this.absentUserHash;
  }

  async login(
    input: LoginRequest,
    fingerprint: RequestFingerprint = {},
  ): Promise<LoginResult | ChallengeResult> {
    const user = await this.findByIdentifier(input.identifier);

    // Verification runs whether or not the account exists, against a real
    // hash in both cases, so the two paths cost the same.
    const passwordMatches = await this.hasher.verify(
      user?.passwordHash ?? (await this.decoyHash()),
      input.password,
    );

    if (!user || !passwordMatches) {
      // Deliberately no user id: an attacker who can read logs should not get
      // the answer the response withheld.
      this.log.info({ outcome: 'rejected' }, 'sign-in attempt failed');
      throw invalidCredentials();
    }

    // A hash made under weaker parameters is upgraded now, while the
    // plaintext is in hand. This is the only moment it can be done.
    if (this.hasher.needsRehash(user.passwordHash)) {
      await this.rehash(user, input.password);
    }

    /*
     * With a second factor on, the password is half the answer.
     *
     * No session is issued here. What comes back is a short-lived challenge
     * that a code must be given against — so a password somebody else knows
     * opens nothing on its own.
     */
    if (this.twoFactor && (await this.twoFactor.isEnabled(user.id))) {
      const challenge = await this.twoFactor.createChallenge(user.id, user.email);
      this.log.info({ userId: user.id }, 'password accepted; a second factor is owed');
      return { user, challenge };
    }

    const issued = await this.sessions.issue(user.id, fingerprint);
    this.log.info({ userId: user.id, sessionId: issued.session.id }, 'user signed in');

    return { user, issued };
  }

  /** The second half of signing in: a code against the challenge. */
  async completeTwoFactor(
    challenge: string,
    code: string,
    fingerprint: RequestFingerprint = {},
  ): Promise<LoginResult> {
    if (!this.twoFactor) {
      throw new AppError('UNAUTHENTICATED', 'Sign in again.', { expose: true });
    }

    const userId = await this.twoFactor.completeChallenge(challenge, code);
    const user = await this.users.findById(userId);
    if (!user) throw new AppError('UNAUTHENTICATED', 'Sign in again.', { expose: true });

    const issued = await this.sessions.issue(user.id, fingerprint);
    this.log.info(
      { userId: user.id, sessionId: issued.session.id },
      'user signed in with a second factor',
    );
    return { user, issued };
  }

  private findByIdentifier(identifier: string): Promise<UserRecord | null> {
    return identifierIsEmail(identifier)
      ? this.users.findByEmail(normalizeEmail(identifier))
      : this.users.findByUsername(identifier);
  }

  private async rehash(user: UserRecord, password: string): Promise<void> {
    try {
      await this.users.updatePasswordHash(user.id, await this.hasher.hash(password));
      this.log.info({ userId: user.id }, 'password hash upgraded to current parameters');
    } catch (error) {
      // The user's credentials are correct; failing their sign-in because an
      // optimisation failed would be the wrong trade.
      this.log.warn({ err: error, userId: user.id }, 'could not upgrade password hash');
    }
  }
}

/**
 * The single failure answer.
 *
 * It names neither field, because naming one would say the other was right.
 */
const invalidCredentials = (): AppError =>
  new AppError('UNAUTHENTICATED', 'Incorrect email, username or password');
