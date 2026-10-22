import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { PasswordHasher } from '../../lib/password.js';
import { generateSessionToken, hashToken, looksLikeSessionToken } from '../../lib/tokens.js';
import type { MailProvider } from '../../mail/provider.js';
import type { SessionRepository } from '../sessions/session.repository.js';
import type { UserRepository, UserRecord } from '../users/user.repository.js';
import type { AccountTokenKind, AccountTokenRepository } from './token.repository.js';

export interface VerificationOptions {
  verificationTtlMinutes: number;
  resetTtlMinutes: number;
  maxPerWindow: number;
  windowMinutes: number;
  publicUrl: string;
}

export class VerificationService {
  constructor(
    private readonly tokens: AccountTokenRepository,
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly mail: MailProvider,
    private readonly hasher: PasswordHasher,
    private readonly options: VerificationOptions,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  unavailableReason(): Promise<string | null> {
    return this.mail.unavailableReason();
  }

  async sendVerification(userId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user)
      throw new AppError('UNAUTHENTICATED', 'Sign in again to continue.', { expose: true });

    if (user.emailVerifiedAt) {
      throw new AppError('VALIDATION_FAILED', 'That address is already verified.', {
        expose: true,
      });
    }

    await this.refuseIfMailIsDown();
    await this.refuseIfTooMany(user.id, 'EMAIL_VERIFICATION');

    const token = await this.issue(user, 'EMAIL_VERIFICATION', this.options.verificationTtlMinutes);

    await this.mail.send({
      to: user.email,
      subject: 'Confirm your email address',
      text: [
        `Hello ${user.username},`,
        '',
        'Open this link to confirm this address belongs to you:',
        '',
        `${this.options.publicUrl}/verify-email?token=${token}`,
        '',
        `The link stops working in ${this.options.verificationTtlMinutes} minutes.`,
        'If you did not create an account here, you can ignore this message.',
      ].join('\n'),
    });

    this.log.info({ userId: user.id }, 'a verification link was sent');
  }

  async confirmVerification(rawToken: string): Promise<{ email: string }> {
    const record = await this.redeem(rawToken, 'EMAIL_VERIFICATION');
    const user = await this.users.findById(record.userId);

    if (!user) {
      throw new AppError('NOT_FOUND', 'That account no longer exists.', { expose: true });
    }

    if (user.email !== record.email) {
      throw new AppError(
        'VALIDATION_FAILED',
        'That link was sent to a different address than the one on this account. Ask for a new one.',
        { expose: true },
      );
    }

    await this.users.markEmailVerified(user.id, this.now());
    this.log.info({ userId: user.id }, 'an email address was verified');

    return { email: user.email };
  }

  async requestReset(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);

    if (!user) {
      this.log.info('a reset was requested for an address with no account');
      return;
    }

    if (await this.mail.unavailableReason()) {
      this.log.warn({ userId: user.id }, 'a reset was requested but mail is unavailable');
      return;
    }

    if (await this.tooMany(user.id, 'PASSWORD_RESET')) {
      this.log.warn({ userId: user.id }, 'a reset was requested too often and was not sent');
      return;
    }

    const token = await this.issue(user, 'PASSWORD_RESET', this.options.resetTtlMinutes);

    try {
      await this.mail.send({
        to: user.email,
        subject: 'Reset your password',
        text: [
          `Hello ${user.username},`,
          '',
          'Somebody asked to reset the password on your account. Open this link to choose a new one:',
          '',
          `${this.options.publicUrl}/reset-password?token=${token}`,
          '',
          `The link stops working in ${this.options.resetTtlMinutes} minutes, and using it signs you out everywhere.`,
          'If this was not you, you do not need to do anything: your password has not changed.',
        ].join('\n'),
      });
    } catch (error) {
      this.log.error({ err: error, userId: user.id }, 'a reset message could not be sent');
    }

    this.log.info({ userId: user.id }, 'a reset link was sent');
  }

  async completeReset(rawToken: string, password: string): Promise<void> {
    const record = await this.redeem(rawToken, 'PASSWORD_RESET');
    const user = await this.users.findById(record.userId);

    if (!user) {
      throw new AppError('NOT_FOUND', 'That account no longer exists.', { expose: true });
    }

    await this.users.updatePasswordHash(user.id, await this.hasher.hash(password));

    const signedOut = await this.sessions.deleteAllForUser(user.id);

    if (!user.emailVerifiedAt && user.email === record.email) {
      await this.users.markEmailVerified(user.id, this.now());
    }

    this.log.info({ userId: user.id, signedOut }, 'a password was reset');
  }

  private async issue(
    user: UserRecord,
    kind: AccountTokenKind,
    ttlMinutes: number,
  ): Promise<string> {
    const now = this.now();

    await this.tokens.invalidateOutstanding(user.id, kind, now);

    const token = generateSessionToken();

    await this.tokens.create({
      userId: user.id,
      kind,
      tokenHash: hashToken(token),
      email: user.email,
      expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
    });

    return token;
  }

  private async redeem(rawToken: string, kind: AccountTokenKind) {
    const generic = new AppError(
      'VALIDATION_FAILED',
      'That link is not valid. Ask for a new one.',
      {
        expose: true,
      },
    );

    if (!looksLikeSessionToken(rawToken)) throw generic;

    const record = await this.tokens.findByHash(hashToken(rawToken));

    if (!record || record.kind !== kind) throw generic;

    if (record.usedAt) {
      throw new AppError('VALIDATION_FAILED', 'That link has already been used.', { expose: true });
    }

    if (record.expiresAt.getTime() <= this.now().getTime()) {
      throw new AppError('VALIDATION_FAILED', 'That link has expired. Ask for a new one.', {
        expose: true,
      });
    }

    if (!(await this.tokens.markUsed(record.id, this.now()))) {
      throw new AppError('VALIDATION_FAILED', 'That link has already been used.', { expose: true });
    }

    return record;
  }

  private async refuseIfMailIsDown(): Promise<void> {
    const reason = await this.mail.unavailableReason();
    if (reason) throw new AppError('SERVICE_UNAVAILABLE', reason, { expose: true });
  }

  private async refuseIfTooMany(userId: string, kind: AccountTokenKind): Promise<void> {
    if (await this.tooMany(userId, kind)) {
      throw new AppError(
        'RATE_LIMITED',
        'Too many messages have been sent to this address recently. Try again shortly.',
        { expose: true },
      );
    }
  }

  private async tooMany(userId: string, kind: AccountTokenKind): Promise<boolean> {
    const since = new Date(this.now().getTime() - this.options.windowMinutes * 60_000);
    return (await this.tokens.countSince(userId, kind, since)) >= this.options.maxPerWindow;
  }
}
