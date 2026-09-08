import type { Logger } from 'pino';
import { generateSessionToken, hashToken, looksLikeSessionToken } from '../../lib/tokens.js';
import type { SessionRecord, SessionRepository } from '../sessions/session.repository.js';
import type { UserRecord } from '../users/user.repository.js';

/**
 * Session lifecycle.
 *
 * Two expiries, and both matter:
 *
 *  - **Absolute**, stored on the row. The session stops working at this point
 *    however active it has been, so a stolen cookie is not useful forever.
 *  - **Idle**, evaluated at read time from `lastSeenAt`. An abandoned session
 *    on a shared machine closes sooner than the absolute limit.
 *
 * Idle expiry is deliberately not stored as a second timestamp. Storing it
 * would mean two columns that can disagree, and it would make changing the
 * idle policy require rewriting every existing row.
 */

export interface SessionOptions {
  absoluteTtlHours: number;
  idleTtlHours: number;
  /** Minimum gap between last-seen writes. */
  lastSeenThrottleSeconds: number;
}

export interface IssuedSession {
  /** Returned to the caller exactly once, to be placed in a cookie. */
  token: string;
  session: SessionRecord;
}

export interface AuthenticatedContext {
  user: UserRecord;
  session: SessionRecord;
}

export interface RequestFingerprint {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

/** Diagnostic only, and attacker-controlled, so it is bounded before storage. */
const USER_AGENT_MAX_LENGTH = 256;

export class SessionService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly options: SessionOptions,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Issues a new session.
   *
   * Always a new row, never a reused one. Signing in must change the token, or
   * a token an attacker planted before sign-in would still be valid after it.
   */
  async issue(userId: string, fingerprint: RequestFingerprint = {}): Promise<IssuedSession> {
    const token = generateSessionToken();
    const expiresAt = new Date(
      this.now().getTime() + this.options.absoluteTtlHours * 60 * 60 * 1000,
    );

    const session = await this.sessions.create({
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      userAgent: fingerprint.userAgent?.slice(0, USER_AGENT_MAX_LENGTH),
      ipAddress: fingerprint.ipAddress,
    });

    this.log.info({ userId, sessionId: session.id }, 'session issued');
    return { token, session };
  }

  /**
   * Resolves a token to its user, or nothing.
   *
   * Every rejection returns undefined rather than throwing. A caller cannot
   * then distinguish "no cookie" from "expired" from "forged", and neither can
   * anyone watching the response.
   */
  async resolve(token: string | undefined): Promise<AuthenticatedContext | undefined> {
    if (!token || !looksLikeSessionToken(token)) return undefined;

    const found = await this.sessions.findByTokenHash(hashToken(token));
    if (!found) return undefined;

    const now = this.now();

    if (found.expiresAt.getTime() <= now.getTime()) {
      // Past its absolute lifetime. Removed now rather than waiting for the
      // sweep, since it is already loaded.
      await this.sessions.deleteById(found.id);
      return undefined;
    }

    if (this.isIdleExpired(found.lastSeenAt, now)) {
      await this.sessions.deleteById(found.id);
      this.log.info({ sessionId: found.id }, 'session expired through inactivity');
      return undefined;
    }

    await this.touchIfStale(found, now);

    const { user, ...session } = found;
    return { user, session };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.sessions.deleteById(sessionId);
    this.log.info({ sessionId }, 'session revoked');
  }

  /** Signs a user out everywhere. Used after a password change, and by choice. */
  async revokeAllForUser(userId: string): Promise<number> {
    const count = await this.sessions.deleteAllForUser(userId);
    this.log.info({ userId, count }, 'all sessions revoked');
    return count;
  }

  /**
   * Removes sessions past their absolute expiry.
   *
   * Idle-expired rows are not swept: recognising them requires the same
   * per-row arithmetic as reading them, and they are removed on the next
   * attempted use anyway. The absolute expiry is indexed, so this stays cheap.
   */
  async sweepExpired(): Promise<number> {
    const count = await this.sessions.deleteExpired(this.now());
    if (count > 0) this.log.info({ count }, 'expired sessions swept');
    return count;
  }

  private isIdleExpired(lastSeenAt: Date, now: Date): boolean {
    const idleMs = this.options.idleTtlHours * 60 * 60 * 1000;
    return now.getTime() - lastSeenAt.getTime() > idleMs;
  }

  /**
   * Refreshes last-seen, but not on every request.
   *
   * Without the throttle each authenticated request becomes a database write,
   * which is a lot of load to buy a timestamp accurate to the second.
   */
  private async touchIfStale(session: SessionRecord, now: Date): Promise<void> {
    const thresholdMs = this.options.lastSeenThrottleSeconds * 1000;
    if (now.getTime() - session.lastSeenAt.getTime() < thresholdMs) return;

    try {
      await this.sessions.touch(session.id, now);
      session.lastSeenAt = now;
    } catch (error) {
      // A failed timestamp refresh must not fail the request the user asked
      // for. The worst case is the session expiring on schedule.
      this.log.warn({ err: error, sessionId: session.id }, 'could not refresh session last-seen');
    }
  }
}
