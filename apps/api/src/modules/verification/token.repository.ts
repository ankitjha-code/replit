import type { Database } from '../../db/client.js';

export type AccountTokenKind = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET' | 'LOGIN_CHALLENGE';

export interface AccountTokenRecord {
  id: string;
  userId: string;
  kind: AccountTokenKind;
  tokenHash: string;
  email: string;
  expiresAt: Date;
  usedAt: Date | null;
  attempts: number;
  createdAt: Date;
}

export interface CreateTokenInput {
  userId: string;
  kind: AccountTokenKind;
  tokenHash: string;
  email: string;
  expiresAt: Date;
}

export class AccountTokenRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateTokenInput): Promise<AccountTokenRecord> {
    return this.db.accountToken.create({ data: input });
  }

  findByHash(tokenHash: string): Promise<AccountTokenRecord | null> {
    return this.db.accountToken.findUnique({ where: { tokenHash } });
  }

  async markUsed(id: string, at: Date): Promise<boolean> {
    const result = await this.db.accountToken.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: at },
    });

    return result.count === 1;
  }

  async invalidateOutstanding(userId: string, kind: AccountTokenKind, at: Date): Promise<number> {
    const result = await this.db.accountToken.updateMany({
      where: { userId, kind, usedAt: null },
      data: { usedAt: at },
    });

    return result.count;
  }

  async recordAttempt(id: string): Promise<number> {
    const updated = await this.db.accountToken.update({
      where: { id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    return updated.attempts;
  }

  countSince(userId: string, kind: AccountTokenKind, since: Date): Promise<number> {
    return this.db.accountToken.count({
      where: { userId, kind, createdAt: { gte: since } },
    });
  }

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.db.accountToken.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return result.count;
  }
}
