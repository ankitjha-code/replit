import type { PublicUser } from '@platform/shared';
import type { Database } from '../../db/client.js';

/**
 * The only code that reads or writes the users table.
 *
 * Services above this layer deal in domain shapes and never see Prisma.
 * Nothing here makes a policy decision: no normalisation, no hashing, no
 * duplicate handling. Those belong to the service, so they are testable
 * without a database.
 */

/** A user as stored, including the password hash. Never leaves the service layer. */
export interface UserRecord {
  id: string;
  email: string;
  username: string;
  passwordHash: string;
  displayName: string | null;
  /** Null until the address has been proved. Not a gate; see the service. */
  emailVerifiedAt: Date | null;
  /** Whether this account may see the installation as a whole. */
  isOperator: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserInput {
  /** Already normalised by the service. */
  email: string;
  username: string;
  passwordHash: string;
  displayName?: string | undefined;
}

/**
 * Postgres unique-violation code. Surfaced as a typed result so the service
 * can distinguish "email taken" from "username taken" without parsing an
 * error message.
 */
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

  /**
   * Replaces the stored hash. Used when a correct password is presented
   * against a hash made under weaker parameters, which is the only moment the
   * plaintext is available to re-derive from.
   */
  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.db.user.update({ where: { id }, data: { passwordHash } });
  }

  /**
   * Records that the address on this account has been proved.
   *
   * Takes the moment rather than reading the clock, so the service decides when
   * "now" is and the same moment can be written across several rows.
   */
  async markEmailVerified(id: string, at: Date): Promise<void> {
    await this.db.user.update({ where: { id }, data: { emailVerifiedAt: at } });
  }

  /**
   * Removes the account.
   *
   * Almost everything a user owns cascades from here, which is convenient and
   * is exactly why this must not be called first: a project's container, its
   * database and its stored archives live outside this database and no cascade
   * reaches them. The service deletes projects properly and only then calls
   * this.
   */
  async deleteById(id: string): Promise<void> {
    await this.db.user.delete({ where: { id } });
  }

  /** Case-insensitive existence check, used to give a clear message early. */
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

/**
 * Strips a stored user down to what may cross the API boundary.
 *
 * Written as an explicit construction rather than deleting fields from a
 * spread, so adding a sensitive column later cannot silently leak it.
 */
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
