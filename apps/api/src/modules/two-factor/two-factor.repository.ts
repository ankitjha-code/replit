import type { Database } from '../../db/client.js';

/**
 * The only code that reads or writes an account's second factor.
 *
 * Separate from the user repository on purpose: the secret is sealed bytes that
 * almost nothing should ever load, and keeping it out of the user record means
 * the dozens of places that read a user never hold it by accident.
 */
export class TwoFactorRepository {
  constructor(private readonly db: Database) {}

  find(userId: string): Promise<{
    totpSecret: Uint8Array | null;
    totpEnabledAt: Date | null;
    totpLastStep: number | null;
  } | null> {
    return this.db.user.findUnique({
      where: { id: userId },
      select: { totpSecret: true, totpEnabledAt: true, totpLastStep: true },
    });
  }

  async isEnabled(userId: string): Promise<boolean> {
    const row = await this.db.user.findUnique({
      where: { id: userId },
      select: { totpEnabledAt: true },
    });
    return row?.totpEnabledAt != null;
  }

  async startEnrolment(userId: string, sealedSecret: Uint8Array): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: { totpSecret: Buffer.from(sealedSecret), totpEnabledAt: null, totpLastStep: null },
    });
  }

  /** Turns it on and replaces the recovery codes, in one transaction. */
  async enable(userId: string, step: number, codeHashes: readonly string[]): Promise<void> {
    await this.db.$transaction([
      this.db.user.update({
        where: { id: userId },
        data: { totpEnabledAt: new Date(), totpLastStep: step },
      }),
      this.db.totpRecoveryCode.deleteMany({ where: { userId } }),
      this.db.totpRecoveryCode.createMany({
        data: codeHashes.map((codeHash) => ({ userId, codeHash })),
      }),
    ]);
  }

  async disable(userId: string): Promise<void> {
    await this.db.$transaction([
      this.db.user.update({
        where: { id: userId },
        data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null },
      }),
      this.db.totpRecoveryCode.deleteMany({ where: { userId } }),
    ]);
  }

  /**
   * Records the step a code was accepted for, but only if it is newer.
   *
   * Conditional in the statement, so two sign-ins racing with the same code
   * cannot both succeed: the second finds the step already taken.
   */
  async claimStep(userId: string, step: number): Promise<boolean> {
    const result = await this.db.user.updateMany({
      where: { id: userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
      data: { totpLastStep: step },
    });
    return result.count === 1;
  }

  /** Spends a recovery code, if it exists, belongs to this account and is unused. */
  async spendRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
    const result = await this.db.totpRecoveryCode.updateMany({
      where: { userId, codeHash, usedAt: null },
      data: { usedAt: new Date() },
    });
    return result.count === 1;
  }

  remainingRecoveryCodes(userId: string): Promise<number> {
    return this.db.totpRecoveryCode.count({ where: { userId, usedAt: null } });
  }
}
