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

export interface TwoFactorOptions {
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
    private readonly box: SecretBox | undefined,
    private readonly options: TwoFactorOptions,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

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

  isEnabled(userId: string): Promise<boolean> {
    return this.factors.isEnabled(userId);
  }

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

    if (!(await this.tokens.markUsed(record.id, this.now()))) throw refused();

    return record.userId;
  }

  private async verifyFactor(userId: string, code: string): Promise<boolean> {
    const trimmed = code.trim();

    if (/^\d{6}$/.test(trimmed)) {
      const box = this.requireBox();
      const row = await this.factors.find(userId);
      if (!row?.totpSecret || !row.totpEnabledAt) return false;

      const secret = Buffer.from(box.open(row.totpSecret), 'base64');
      const step = matchingStep(secret, trimmed, this.now());
      if (step === undefined) return false;

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

function recoveryCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(10);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

function normalise(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}
