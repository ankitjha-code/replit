import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { PasswordHasher } from '../../lib/password.js';
import type { SecretBox } from '../../lib/secret-box.js';
import { generateSessionToken, hashToken, looksLikeSessionToken } from '../../lib/tokens.js';
import { base32, matchingStep, newSecret, otpauthUri } from '../../lib/totp.js';
import type { UserRepository } from '../users/user.repository.js';
import type { AccountTokenRepository } from '../verification/token.repository.js';
import type { TwoFactorRepository } from './two-factor.repository.js';

/**
 * A second factor at sign-in.
 *
 * ## What it protects against
 *
 * A password that is known to somebody else — guessed, phished, reused from a
 * site that leaked. With a second factor turned on, the password alone opens
 * nothing: signing in also needs a code from a device the account holder has.
 *
 * ## The decisions
 *
 * - **Nothing counts until it has been proved.** Starting enrolment stores a
 *   secret that does nothing; only a correct code from the person's app turns it
 *   on. Otherwise a mistyped setup would lock somebody out of their own account.
 * - **A code works once.** It is valid for a thirty-second window, so the step it
 *   was accepted for is recorded and the same code is refused after that.
 * - **A sign-in challenge is burned after five wrong codes.** Six digits is a
 *   million possibilities; five tries at a fresh challenge each needing the
 *   password first is not a practical way through them.
 * - **Recovery codes are shown once and stored as hashes**, like session
 *   tokens: a dump of the database cannot be used to get past the second factor.
 * - **Turning it off needs the password and a code.** A borrowed session must
 *   not be enough to remove the thing that protects against a stolen password.
 */

export interface TwoFactorOptions {
  /** How the platform is named in somebody's authenticator app. */
  issuer: string;
  challengeTtlMinutes: number;
  maxChallengeAttempts: number;
  recoveryCodeCount: number;
}

export class TwoFactorService {
  constructor(
    private readonly factors: TwoFactorRepository,
    private readonly users: UserRepository,
    private readonly tokens: AccountTokenRepository,
    private readonly hasher: PasswordHasher,
    /** Absent when the installation has no encryption key. */
    private readonly box: SecretBox | undefined,
    private readonly options: TwoFactorOptions,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Why two-factor cannot be used here, or null when it can. */
  unavailableReason(): string | null {
    return this.box
      ? null
      : 'This installation has no encryption key configured, so a second factor cannot be stored.';
  }

  async status(
    userId: string,
  ): Promise<{ enabled: boolean; recoveryCodesLeft: number; available: boolean }> {
    const enabled = await this.factors.isEnabled(userId);
    return {
      enabled,
      recoveryCodesLeft: enabled ? await this.factors.remainingRecoveryCodes(userId) : 0,
      available: this.box !== undefined,
    };
  }

  /** Whether signing in to this account needs a code as well. */
  isEnabled(userId: string): Promise<boolean> {
    return this.factors.isEnabled(userId);
  }

  /**
   * Starts turning it on: a new secret, not yet in force.
   *
   * Returned so it can be shown once — as a link an authenticator app opens and
   * as text for typing in. Refused while it is already on: replacing an active
   * secret would lock the person out of the codes their app is producing.
   */
  async beginEnrolment(userId: string): Promise<{ secret: string; uri: string }> {
    const box = this.requireBox();
    const user = await this.users.findById(userId);
    if (!user)
      throw new AppError('UNAUTHENTICATED', 'Sign in again to continue.', { expose: true });

    if (await this.factors.isEnabled(userId)) {
      throw new AppError(
        'CONFLICT',
        'A second factor is already on. Turn it off first to replace it.',
        {
          expose: true,
        },
      );
    }

    const secret = newSecret();
    await this.factors.startEnrolment(userId, box.seal(secret.toString('base64')));

    return { secret: base32(secret), uri: otpauthUri(secret, this.options.issuer, user.username) };
  }

  /**
   * Turns it on, once a code proves the person's app has the secret.
   *
   * Returns the recovery codes — the only time they are ever shown.
   */
  async confirmEnrolment(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const box = this.requireBox();
    const row = await this.factors.find(userId);

    if (!row?.totpSecret || row.totpEnabledAt) {
      throw new AppError('PRECONDITION_FAILED', 'Start setting up a second factor first.', {
        expose: true,
      });
    }

    const secret = Buffer.from(box.open(row.totpSecret), 'base64');
    const step = matchingStep(secret, code.trim(), this.now());

    if (step === undefined) {
      throw new AppError(
        'VALIDATION_FAILED',
        'That code is not right. Check the time on your device and try again.',
        {
          expose: true,
          context: { field: 'code' },
        },
      );
    }

    const recoveryCodes = Array.from({ length: this.options.recoveryCodeCount }, () =>
      recoveryCode(),
    );
    await this.factors.enable(
      userId,
      step,
      recoveryCodes.map((value) => hashToken(normalise(value))),
    );

    this.log.info({ userId }, 'a second factor was turned on');
    return { recoveryCodes };
  }

  /** Turns it off, with the password and a current code (or a recovery code). */
  async disable(userId: string, input: { password: string; code: string }): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user)
      throw new AppError('UNAUTHENTICATED', 'Sign in again to continue.', { expose: true });

    if (!(await this.hasher.verify(user.passwordHash, input.password))) {
      throw new AppError('VALIDATION_FAILED', 'That is not your password.', {
        expose: true,
        context: { field: 'password' },
      });
    }

    if (!(await this.verifyFactor(userId, input.code))) {
      throw new AppError('VALIDATION_FAILED', 'That code is not right.', {
        expose: true,
        context: { field: 'code' },
      });
    }

    await this.factors.disable(userId);
    this.log.info({ userId }, 'a second factor was turned off');
  }

  /**
   * The half-finished sign-in: password accepted, code still owed.
   *
   * A short-lived single-use token, hashed at rest like everything else of the
   * kind. It is not a session and grants nothing on its own.
   */
  async createChallenge(userId: string, email: string): Promise<string> {
    const token = generateSessionToken();
    await this.tokens.create({
      userId,
      kind: 'LOGIN_CHALLENGE',
      tokenHash: hashToken(token),
      email,
      expiresAt: new Date(this.now().getTime() + this.options.challengeTtlMinutes * 60_000),
    });
    return token;
  }

  /**
   * Finishes a sign-in with a code, returning whose it is.
   *
   * One answer for every way it can fail except the last attempt, so a guess
   * learns nothing but "no". The challenge is spent on success and burned when
   * the attempts run out.
   */
  async completeChallenge(challenge: string, code: string): Promise<string> {
    const refused = () =>
      new AppError(
        'UNAUTHENTICATED',
        'That code is not right, or the sign-in has expired. Sign in again.',
        {
          expose: true,
        },
      );

    if (!looksLikeSessionToken(challenge)) throw refused();

    const record = await this.tokens.findByHash(hashToken(challenge));
    if (
      !record ||
      record.kind !== 'LOGIN_CHALLENGE' ||
      record.usedAt ||
      record.expiresAt.getTime() <= this.now().getTime() ||
      record.attempts >= this.options.maxChallengeAttempts
    ) {
      throw refused();
    }

    if (!(await this.verifyFactor(record.userId, code))) {
      const attempts = await this.tokens.recordAttempt(record.id);
      if (attempts >= this.options.maxChallengeAttempts) {
        await this.tokens.markUsed(record.id, this.now());
        this.log.warn(
          { userId: record.userId },
          'a sign-in challenge was burned after too many wrong codes',
        );
      }
      throw refused();
    }

    // Spent before the session is issued, so the same challenge cannot finish
    // two sign-ins.
    if (!(await this.tokens.markUsed(record.id, this.now()))) throw refused();

    return record.userId;
  }

  /** A current TOTP code (once), or an unused recovery code. */
  private async verifyFactor(userId: string, code: string): Promise<boolean> {
    const trimmed = code.trim();

    if (/^\d{6}$/.test(trimmed)) {
      const box = this.requireBox();
      const row = await this.factors.find(userId);
      if (!row?.totpSecret || !row.totpEnabledAt) return false;

      const secret = Buffer.from(box.open(row.totpSecret), 'base64');
      const step = matchingStep(secret, trimmed, this.now());
      if (step === undefined) return false;

      // Refused if this step — or a later one — was already used.
      return this.factors.claimStep(userId, step);
    }

    return this.factors.spendRecoveryCode(userId, hashToken(normalise(trimmed)));
  }

  private requireBox(): SecretBox {
    if (!this.box) {
      throw new AppError('SERVICE_UNAVAILABLE', this.unavailableReason() ?? '', { expose: true });
    }
    return this.box;
  }
}

/** Ten characters from an unambiguous alphabet, shown as two groups of five. */
function recoveryCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(10);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** Recovery codes are compared without the dash and without case. */
function normalise(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}
