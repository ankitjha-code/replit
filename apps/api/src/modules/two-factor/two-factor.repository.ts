import type { Database } from '../../db/client.js';

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

  async claimStep(userId: string, step: number): Promise<boolean> {
    const result = await this.db.user.updateMany({
      where: { id: userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
      data: { totpLastStep: step },
    });
    return result.count === 1;
  }

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
