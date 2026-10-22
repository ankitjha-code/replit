import type { Database } from '../../db/client.js';

/**
 * The only code that reads or writes the account-token table.
 *
 * No policy here: how long a token lasts, what invalidates it and what
 * redeeming one means all belong to the service. This layer stores what it is
 * given and returns what it finds, and it never sees a token — only a hash the
 * service derived.
 */

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
  /** Already hashed by the service. The token itself never reaches this layer. */
  tokenHash: string;
  email: string;
  expiresAt: Date;
}

export class AccountTokenRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateTokenInput): Promise<AccountTokenRecord> {
    return this.db.accountToken.create({ data: input });
  }

  /**
   * Finds a token by its hash, whatever state it is in.
   *
   * Expired and already-used tokens come back too, because the service has to
   * tell them apart: "that link has expired" and "that link has already been
   * used" are different things to be told, and both are better than a blanket
   * refusal that leaves somebody clicking the same link again.
   */
  findByHash(tokenHash: string): Promise<AccountTokenRecord | null> {
    return this.db.accountToken.findUnique({ where: { tokenHash } });
  }

  /**
   * Marks one used, but only if it is still unused.
   *
   * The condition is in the statement rather than in a check before it. Two
   * requests arriving with the same token — a link clicked twice, a mail client
   * prefetching — must not both succeed, and a read followed by a write is
   * exactly the shape that lets them.
   */
  async markUsed(id: string, at: Date): Promise<boolean> {
    const result = await this.db.accountToken.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: at },
    });

    return result.count === 1;
  }

  /**
   * Retires every outstanding token of one kind for one account.
   *
   * Called when a new one is issued, so asking twice does not leave two live
   * links: the older message becomes useless the moment the newer one is sent,
   * which is what somebody expects and is one fewer live credential in an inbox.
   */
  async invalidateOutstanding(userId: string, kind: AccountTokenKind, at: Date): Promise<number> {
    const result = await this.db.accountToken.updateMany({
      where: { userId, kind, usedAt: null },
      data: { usedAt: at },
    });

    return result.count;
  }

  /**
   * Counts one wrong answer against a sign-in challenge, and says how many.
   *
   * An atomic increment, so two guesses racing cannot both read the old count
   * and both be allowed.
   */
  async recordAttempt(id: string): Promise<number> {
    const updated = await this.db.accountToken.update({
      where: { id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    return updated.attempts;
  }

  /** How many were issued since a moment, for the per-account ceiling. */
  countSince(userId: string, kind: AccountTokenKind, since: Date): Promise<number> {
    return this.db.accountToken.count({
      where: { userId, kind, createdAt: { gte: since } },
    });
  }

  /** Removes tokens past their expiry. Nothing here is useful once expired. */
  async deleteExpired(now: Date): Promise<number> {
    const result = await this.db.accountToken.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return result.count;
  }
}
