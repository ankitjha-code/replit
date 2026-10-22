import type { Database } from '../../db/client.js';
import type { UserRecord } from '../users/user.repository.js';

/**
 * The only code that reads or writes the sessions table.
 *
 * No policy here: expiry decisions, throttling and token handling belong to
 * the service. This layer stores what it is given and returns what it finds.
 */

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  lastSeenAt: Date;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
}

export interface CreateSessionInput {
  userId: string;
  /** Already hashed by the service. The raw token never reaches this layer. */
  tokenHash: string;
  expiresAt: Date;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

export class SessionRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateSessionInput): Promise<SessionRecord> {
    return this.db.session.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        userAgent: input.userAgent ?? null,
        ipAddress: input.ipAddress ?? null,
      },
    });
  }

  /**
   * Loads a session and its user together.
   *
   * One query rather than two, because this runs on every authenticated
   * request and the user is always needed alongside the session.
   */
  findByTokenHash(tokenHash: string): Promise<(SessionRecord & { user: UserRecord }) | null> {
    return this.db.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
  }

  touch(id: string, at: Date): Promise<unknown> {
    return this.db.session.update({ where: { id }, data: { lastSeenAt: at } });
  }

  async deleteById(id: string): Promise<void> {
    // Deleting an already-deleted session is not an error: signing out twice
    // is a normal thing for a browser to do.
    await this.db.session.deleteMany({ where: { id } });
  }

  async deleteAllForUser(userId: string): Promise<number> {
    const result = await this.db.session.deleteMany({ where: { userId } });
    return result.count;
  }

  /** Removes sessions past their absolute expiry. Idle expiry is a read-time rule. */
  async deleteExpired(now: Date): Promise<number> {
    const result = await this.db.session.deleteMany({ where: { expiresAt: { lt: now } } });
    return result.count;
  }

  /**
   * One account's sessions, newest first.
   *
   * Returns whole rows including the token hash, because this layer stores what
   * it is given and returns what it finds. Deciding what may be shown to a
   * person is the service's job, and the shape that leaves the server has no
   * field a hash could go in.
   */
  listForUser(userId: string): Promise<SessionRecord[]> {
    return this.db.session.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  /**
   * Finds a session, but only if it belongs to this account.
   *
   * The ownership check is in the query rather than after it. A lookup by
   * identifier alone followed by a comparison is the shape that becomes a bug
   * the day somebody forgets the comparison, and the bug is one account ending
   * another's session.
   */
  findOwned(id: string, userId: string): Promise<SessionRecord | null> {
    return this.db.session.findFirst({ where: { id, userId } });
  }

  /**
   * Ends every session but one.
   *
   * The exception is the session asking, which is what makes "sign out
   * everywhere else" different from signing yourself out too — somebody
   * securing an account should not have to sign back in to finish doing it.
   */
  async deleteAllForUserExcept(userId: string, keepId: string): Promise<number> {
    const result = await this.db.session.deleteMany({
      where: { userId, NOT: { id: keepId } },
    });
    return result.count;
  }

  countForUser(userId: string): Promise<number> {
    return this.db.session.count({ where: { userId } });
  }
}
