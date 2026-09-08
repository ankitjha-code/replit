import { pino } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../../lib/tokens.js';
import type {
  CreateSessionInput,
  SessionRecord,
  SessionRepository,
} from '../sessions/session.repository.js';
import type { UserRecord } from '../users/user.repository.js';
import { SessionService } from './session.service.js';

const silent = pino({ level: 'silent' });

const user = (): UserRecord => ({
  id: 'user-1',
  email: 'ada@example.test',
  username: 'ada',
  passwordHash: 'fake',
  displayName: null,
  emailVerifiedAt: null,
  isOperator: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
});

/**
 * An in-memory stand-in for the sessions table.
 *
 * Expiry, throttling and token handling are all decisions the service makes,
 * so none of them need a database to verify. Time is injected, which is the
 * only way to test a 30-day lifetime without waiting for one.
 */
class FakeSessionRepository {
  rows: (SessionRecord & { user: UserRecord })[] = [];
  private nextId = 1;
  touchCalls = 0;
  touchShouldFail = false;

  create = vi.fn(async (input: CreateSessionInput): Promise<SessionRecord> => {
    const row = {
      id: `session-${this.nextId++}`,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      lastSeenAt: this.now,
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
      createdAt: this.now,
      user: user(),
    };
    this.rows.push(row);
    return row;
  });

  now = new Date('2026-01-01T00:00:00Z');

  findByTokenHash = vi.fn(
    async (tokenHash: string) => this.rows.find((r) => r.tokenHash === tokenHash) ?? null,
  );

  touch = vi.fn(async (id: string, at: Date) => {
    this.touchCalls += 1;
    if (this.touchShouldFail) throw new Error('write failed');
    const row = this.rows.find((r) => r.id === id);
    if (row) row.lastSeenAt = at;
    return row;
  });

  deleteById = vi.fn(async (id: string) => {
    this.rows = this.rows.filter((r) => r.id !== id);
  });

  deleteAllForUser = vi.fn(async (userId: string) => {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.userId !== userId);
    return before - this.rows.length;
  });

  deleteExpired = vi.fn(async (now: Date) => {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.expiresAt.getTime() >= now.getTime());
    return before - this.rows.length;
  });

  countForUser = vi.fn(
    async (userId: string) => this.rows.filter((r) => r.userId === userId).length,
  );
}

const OPTIONS = { absoluteTtlHours: 24, idleTtlHours: 2, lastSeenThrottleSeconds: 60 };

let repository: FakeSessionRepository;
let clock: Date;
let service: SessionService;

const advance = (ms: number): void => {
  clock = new Date(clock.getTime() + ms);
};

beforeEach(() => {
  repository = new FakeSessionRepository();
  clock = new Date('2026-01-01T00:00:00Z');
  repository.now = clock;
  service = new SessionService(
    repository as unknown as SessionRepository,
    OPTIONS,
    silent,
    () => clock,
  );
});

describe('issuing a session', () => {
  it('returns a token and stores only its digest', async () => {
    const { token } = await service.issue('user-1');

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(repository.rows[0]?.tokenHash).toBe(hashToken(token));
    // The raw token must not be recoverable from what was stored.
    expect(repository.rows[0]?.tokenHash).not.toContain(token);
  });

  it('sets the absolute expiry from the configured lifetime', async () => {
    const { session } = await service.issue('user-1');
    expect(session.expiresAt.getTime()).toBe(clock.getTime() + 24 * 60 * 60 * 1000);
  });

  it('issues a different token every time', async () => {
    const first = await service.issue('user-1');
    const second = await service.issue('user-1');
    // A reused token would mean signing in again did not invalidate anything.
    expect(first.token).not.toBe(second.token);
    expect(first.session.id).not.toBe(second.session.id);
  });

  it('records the request fingerprint for the user to review', async () => {
    await service.issue('user-1', { userAgent: 'Mozilla/5.0', ipAddress: '203.0.113.9' });
    expect(repository.rows[0]?.userAgent).toBe('Mozilla/5.0');
    expect(repository.rows[0]?.ipAddress).toBe('203.0.113.9');
  });

  it('bounds an oversized user agent before storing it', async () => {
    await service.issue('user-1', { userAgent: 'x'.repeat(1000) });
    // The value is attacker-controlled and the column is finite.
    expect(repository.rows[0]?.userAgent).toHaveLength(256);
  });
});

describe('resolving a session', () => {
  it('returns the user for a valid token', async () => {
    const { token } = await service.issue('user-1');
    const resolved = await service.resolve(token);
    expect(resolved?.user.id).toBe('user-1');
  });

  it('returns nothing for no token at all', async () => {
    await expect(service.resolve(undefined)).resolves.toBeUndefined();
    await expect(service.resolve('')).resolves.toBeUndefined();
  });

  it('rejects a malformed token without touching the database', async () => {
    await expect(service.resolve('not-a-real-token')).resolves.toBeUndefined();
    expect(repository.findByTokenHash).not.toHaveBeenCalled();
  });

  it('returns nothing for a well-formed token that was never issued', async () => {
    const forged = 'A'.repeat(43);
    await expect(service.resolve(forged)).resolves.toBeUndefined();
  });

  it('rejects a session past its absolute expiry', async () => {
    const { token } = await service.issue('user-1');
    advance(25 * 60 * 60 * 1000);
    await expect(service.resolve(token)).resolves.toBeUndefined();
  });

  it('deletes a session it found to be expired', async () => {
    const { token } = await service.issue('user-1');
    advance(25 * 60 * 60 * 1000);
    await service.resolve(token);
    expect(repository.rows).toHaveLength(0);
  });

  it('rejects a session left idle past the idle limit', async () => {
    const { token } = await service.issue('user-1');
    // Well inside the 24-hour absolute limit, past the 2-hour idle one.
    advance(3 * 60 * 60 * 1000);
    await expect(service.resolve(token)).resolves.toBeUndefined();
    expect(repository.rows).toHaveLength(0);
  });

  it('keeps a session alive while it is being used', async () => {
    const { token } = await service.issue('user-1');

    for (let i = 0; i < 10; i += 1) {
      advance(90 * 60 * 1000); // 90 minutes, inside the 2-hour idle window
      expect(await service.resolve(token)).toBeDefined();
    }
  });

  it('still expires an actively used session at the absolute limit', async () => {
    const { token } = await service.issue('user-1');

    // Kept alive by use for 22.5 hours, comfortably inside the 24-hour limit.
    for (let i = 0; i < 15; i += 1) {
      advance(90 * 60 * 1000);
      expect(await service.resolve(token)).toBeDefined();
    }

    // Two more hours crosses it. Activity no longer helps.
    advance(2 * 60 * 60 * 1000);
    await expect(service.resolve(token)).resolves.toBeUndefined();
  });
});

describe('last-seen refresh', () => {
  it('does not write on every request', async () => {
    const { token } = await service.issue('user-1');

    for (let i = 0; i < 5; i += 1) {
      advance(1_000);
      await service.resolve(token);
    }

    // Five requests inside the throttle window buy one timestamp at most.
    expect(repository.touchCalls).toBe(0);
  });

  it('writes once the throttle window has passed', async () => {
    const { token } = await service.issue('user-1');
    advance(61_000);
    await service.resolve(token);
    expect(repository.touchCalls).toBe(1);
  });

  it('does not fail the request when the refresh write fails', async () => {
    // The user asked for something else; a failed timestamp is not their problem.
    const { token } = await service.issue('user-1');
    repository.touchShouldFail = true;
    advance(61_000);
    await expect(service.resolve(token)).resolves.toBeDefined();
  });
});

describe('revoking sessions', () => {
  it('invalidates the token immediately', async () => {
    const { token, session } = await service.issue('user-1');
    await service.revoke(session.id);
    await expect(service.resolve(token)).resolves.toBeUndefined();
  });

  it('revoking an already-revoked session is not an error', async () => {
    const { session } = await service.issue('user-1');
    await service.revoke(session.id);
    await expect(service.revoke(session.id)).resolves.toBeUndefined();
  });

  it('signs a user out of every session at once', async () => {
    const first = await service.issue('user-1');
    const second = await service.issue('user-1');

    expect(await service.revokeAllForUser('user-1')).toBe(2);
    await expect(service.resolve(first.token)).resolves.toBeUndefined();
    await expect(service.resolve(second.token)).resolves.toBeUndefined();
  });

  it('leaves other users signed in', async () => {
    const mine = await service.issue('user-1');
    await service.issue('user-2');

    await service.revokeAllForUser('user-2');
    expect(await service.resolve(mine.token)).toBeDefined();
  });
});

describe('sweeping', () => {
  it('removes sessions past their absolute expiry', async () => {
    await service.issue('user-1');
    await service.issue('user-2');
    advance(25 * 60 * 60 * 1000);

    expect(await service.sweepExpired()).toBe(2);
    expect(repository.rows).toHaveLength(0);
  });

  it('leaves valid sessions alone', async () => {
    await service.issue('user-1');
    advance(60_000);
    expect(await service.sweepExpired()).toBe(0);
    expect(repository.rows).toHaveLength(1);
  });
});
