import type { Database } from '../../db/client.js';
import type { UserRecord } from '../users/user.repository.js';

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
    await this.db.session.deleteMany({ where: { id } });
  }

  async deleteAllForUser(userId: string): Promise<number> {
    const result = await this.db.session.deleteMany({ where: { userId } });
    return result.count;
  }

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.db.session.deleteMany({ where: { expiresAt: { lt: now } } });
    return result.count;
  }

  listForUser(userId: string): Promise<SessionRecord[]> {
    return this.db.session.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  findOwned(id: string, userId: string): Promise<SessionRecord | null> {
    return this.db.session.findFirst({ where: { id, userId } });
  }

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
