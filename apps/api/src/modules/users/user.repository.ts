import type { PublicUser } from '@platform/shared';
import type { Database } from '../../db/client.js';

export interface UserRecord {
  id: string;
  email: string;
  username: string;
  passwordHash: string;
  displayName: string | null;
  emailVerifiedAt: Date | null;
  isOperator: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserInput {
  email: string;
  username: string;
  passwordHash: string;
  displayName?: string | undefined;
}

const UNIQUE_VIOLATION = 'P2002';

export type CreateUserResult =
  { ok: true; user: UserRecord } | { ok: false; conflict: 'email' | 'username' | 'unknown' };

export class UserRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateUserInput): Promise<CreateUserResult> {
    try {
      const user = await this.db.user.create({
        data: {
          email: input.email,
          username: input.username,
          passwordHash: input.passwordHash,
          displayName: input.displayName ?? null,
        },
      });
      return { ok: true, user };
    } catch (error) {
      const conflict = uniqueConflictTarget(error);
      if (conflict) return { ok: false, conflict };
      throw error;
    }
  }

  findByEmail(email: string): Promise<UserRecord | null> {
    return this.db.user.findUnique({ where: { email } });
  }

  findByUsername(username: string): Promise<UserRecord | null> {
    return this.db.user.findUnique({ where: { username } });
  }

  findById(id: string): Promise<UserRecord | null> {
    return this.db.user.findUnique({ where: { id } });
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.db.user.update({ where: { id }, data: { passwordHash } });
  }

  async markEmailVerified(id: string, at: Date): Promise<void> {
    await this.db.user.update({ where: { id }, data: { emailVerifiedAt: at } });
  }

  async deleteById(id: string): Promise<void> {
    await this.db.user.delete({ where: { id } });
  }

  async existsByEmailOrUsername(
    email: string,
    username: string,
  ): Promise<{ email: boolean; username: boolean }> {
    const matches = await this.db.user.findMany({
      where: {
        OR: [{ email }, { username: { equals: username, mode: 'insensitive' } }],
      },
      select: { email: true, username: true },
    });

    return {
      email: matches.some((m) => m.email === email),
      username: matches.some((m) => m.username.toLowerCase() === username.toLowerCase()),
    };
  }
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString(),
    emailVerified: user.emailVerifiedAt !== null,
    isOperator: user.isOperator,
  };
}

function uniqueConflictTarget(error: unknown): 'email' | 'username' | 'unknown' | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== UNIQUE_VIOLATION) return undefined;

  const target = candidate.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];

  if (fields.some((f) => f.includes('email'))) return 'email';
  if (fields.some((f) => f.includes('username'))) return 'username';
  return 'unknown';
}
