import { randomBytes } from 'node:crypto';
import { identifierIsEmail, normalizeEmail, type LoginRequest } from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { PasswordHasher } from '../../lib/password.js';
import type { UserRecord, UserRepository } from '../users/user.repository.js';
import type { IssuedSession, RequestFingerprint, SessionService } from './session.service.js';

export interface LoginResult {
  user: UserRecord;
  issued: IssuedSession;
}

export interface ChallengeResult {
  user: UserRecord;
  challenge: string;
}

export class AuthenticationService {
  private absentUserHash: Promise<string> | undefined;

  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionService,
    private readonly hasher: PasswordHasher,
    private readonly log: Logger,
  ) {}

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

    const passwordMatches = await this.hasher.verify(
      user?.passwordHash ?? (await this.decoyHash()),
      input.password,
    );

    if (!user || !passwordMatches) {
      this.log.info({ outcome: 'rejected' }, 'sign-in attempt failed');
      throw invalidCredentials();
    }

    if (this.hasher.needsRehash(user.passwordHash)) {
      await this.rehash(user, input.password);
    }

    if (this.twoFactor && (await this.twoFactor.isEnabled(user.id))) {
      const challenge = await this.twoFactor.createChallenge(user.id, user.email);
      this.log.info({ userId: user.id }, 'password accepted; a second factor is owed');
      return { user, challenge };
    }

    const issued = await this.sessions.issue(user.id, fingerprint);
    this.log.info({ userId: user.id, sessionId: issued.session.id }, 'user signed in');

    return { user, issued };
  }

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
      this.log.warn({ err: error, userId: user.id }, 'could not upgrade password hash');
    }
  }
}

const invalidCredentials = (): AppError =>
  new AppError('UNAUTHENTICATED', 'Incorrect email, username or password');
