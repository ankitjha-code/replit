import type { Logger } from 'pino';
import { generateSessionToken, hashToken, looksLikeSessionToken } from '../../lib/tokens.js';
import type { SessionRecord, SessionRepository } from '../sessions/session.repository.js';
import type { UserRecord } from '../users/user.repository.js';

export interface SessionOptions {
  absoluteTtlHours: number;
  idleTtlHours: number;
  lastSeenThrottleSeconds: number;
}

export interface IssuedSession {
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

const USER_AGENT_MAX_LENGTH = 256;

export class SessionService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly options: SessionOptions,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

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

  async resolve(token: string | undefined): Promise<AuthenticatedContext | undefined> {
    if (!token || !looksLikeSessionToken(token)) return undefined;

    const found = await this.sessions.findByTokenHash(hashToken(token));
    if (!found) return undefined;

    const now = this.now();

    if (found.expiresAt.getTime() <= now.getTime()) {
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

  async revokeAllForUser(userId: string): Promise<number> {
    const count = await this.sessions.deleteAllForUser(userId);
    this.log.info({ userId, count }, 'all sessions revoked');
    return count;
  }

  async sweepExpired(): Promise<number> {
    const count = await this.sessions.deleteExpired(this.now());
    if (count > 0) this.log.info({ count }, 'expired sessions swept');
    return count;
  }

  private isIdleExpired(lastSeenAt: Date, now: Date): boolean {
    const idleMs = this.options.idleTtlHours * 60 * 60 * 1000;
    return now.getTime() - lastSeenAt.getTime() > idleMs;
  }

  private async touchIfStale(session: SessionRecord, now: Date): Promise<void> {
    const thresholdMs = this.options.lastSeenThrottleSeconds * 1000;
    if (now.getTime() - session.lastSeenAt.getTime() < thresholdMs) return;

    try {
      await this.sessions.touch(session.id, now);
      session.lastSeenAt = now;
    } catch (error) {
      this.log.warn({ err: error, sessionId: session.id }, 'could not refresh session last-seen');
    }
  }
}
