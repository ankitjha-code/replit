import { pino } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppError } from '../../errors/app-error.js';
import type { PasswordHasher } from '../../lib/password.js';
import type { UserRecord, UserRepository } from '../users/user.repository.js';
import { AuthenticationService } from './authentication.service.js';
import type { IssuedSession, SessionService } from './session.service.js';

const silent = pino({ level: 'silent' });

const STORED: UserRecord = {
  id: 'user-1',
  email: 'ada@example.test',
  username: 'ada',
  passwordHash: 'hashed:analytical-engine-1843',
  displayName: null,
  emailVerifiedAt: null,
  isOperator: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

class FakeUserRepository {
  rows: UserRecord[] = [{ ...STORED }];
  updatedHashes: { id: string; hash: string }[] = [];
  updateShouldFail = false;

  findByEmail = vi.fn(async (email: string) => this.rows.find((r) => r.email === email) ?? null);
  findByUsername = vi.fn(
    async (username: string) => this.rows.find((r) => r.username === username) ?? null,
  );
  updatePasswordHash = vi.fn(async (id: string, hash: string) => {
    if (this.updateShouldFail) throw new Error('write failed');
    this.updatedHashes.push({ id, hash });
  });
}

class TrackingHasher implements PasswordHasher {
  verifyCalls: string[] = [];
  hashCalls = 0;
  rehashNeeded = false;

  hash(plaintext: string): Promise<string> {
    this.hashCalls += 1;
    return Promise.resolve(`hashed:${plaintext}`);
  }

  verify(hashValue: string, plaintext: string): Promise<boolean> {
    this.verifyCalls.push(hashValue);
    return Promise.resolve(hashValue === `hashed:${plaintext}`);
  }

  needsRehash(): boolean {
    return this.rehashNeeded;
  }
}

class FakeSessionService {
  issued: string[] = [];

  issue = vi.fn(async (userId: string): Promise<IssuedSession> => {
    this.issued.push(userId);
    return {
      token: `token-${this.issued.length}`,
      session: {
        id: `session-${this.issued.length}`,
        userId,
        tokenHash: 'digest',
        expiresAt: new Date('2026-02-01T00:00:00Z'),
        lastSeenAt: new Date('2026-01-01T00:00:00Z'),
        userAgent: null,
        ipAddress: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    };
  });
}

let users: FakeUserRepository;
let hasher: TrackingHasher;
let sessions: FakeSessionService;
let service: AuthenticationService;

const build = (): AuthenticationService =>
  new AuthenticationService(
    users as unknown as UserRepository,
    sessions as unknown as SessionService,
    hasher,
    silent,
  );

beforeEach(() => {
  users = new FakeUserRepository();
  hasher = new TrackingHasher();
  sessions = new FakeSessionService();
  service = build();
});

const credentials = { identifier: 'ada@example.test', password: 'analytical-engine-1843' };

describe('signing in', () => {
  it('accepts correct credentials by email', async () => {
    const result = await service.login(credentials);
    expect(result.user.id).toBe('user-1');
    // No second factor configured, so the password alone issues a session.
    expect('issued' in result && result.issued.token).toBe('token-1');
  });

  it('accepts correct credentials by username', async () => {
    const result = await service.login({ ...credentials, identifier: 'ada' });
    expect(result.user.id).toBe('user-1');
  });

  it('normalises a differently-cased email', async () => {
    await expect(
      service.login({ ...credentials, identifier: '  ADA@Example.TEST ' }),
    ).resolves.toBeDefined();
  });

  it('issues a fresh session rather than reusing one', async () => {
    // Session fixation: a token planted before sign-in must not survive it.
    await service.login(credentials);
    await service.login(credentials);
    expect(sessions.issue).toHaveBeenCalledTimes(2);
  });

  it('passes the request fingerprint through to the session', async () => {
    await service.login(credentials, { userAgent: 'agent', ipAddress: '203.0.113.9' });
    expect(sessions.issue).toHaveBeenCalledWith('user-1', {
      userAgent: 'agent',
      ipAddress: '203.0.113.9',
    });
  });
});

describe('rejecting bad credentials', () => {
  const expectRejection = async (input: typeof credentials): Promise<AppError> => {
    const error = (await service.login(input).catch((e: unknown) => e)) as AppError;
    expect(error.code).toBe('UNAUTHENTICATED');
    return error;
  };

  it('rejects a wrong password', async () => {
    await expectRejection({ ...credentials, password: 'wrong-password-here' });
  });

  it('rejects an unknown email', async () => {
    await expectRejection({ ...credentials, identifier: 'nobody@example.test' });
  });

  it('rejects an unknown username', async () => {
    await expectRejection({ ...credentials, identifier: 'nobody' });
  });

  it('gives the same answer whether or not the account exists', async () => {
    const wrongPassword = await expectRejection({ ...credentials, password: 'wrong-password' });
    const noSuchUser = await expectRejection({
      ...credentials,
      identifier: 'nobody@example.test',
    });

    // Any difference here turns sign-in into an oracle for which accounts exist.
    expect(noSuchUser.message).toBe(wrongPassword.message);
    expect(noSuchUser.status).toBe(wrongPassword.status);
    expect(noSuchUser.details).toEqual(wrongPassword.details);
  });

  it('names neither field in the message', async () => {
    const error = await expectRejection({ ...credentials, password: 'wrong-password' });
    // Naming one would say the other was right.
    expect(error.message).toBe('Incorrect email, username or password');
    expect(error.details).toBeUndefined();
  });

  it('still performs a verification when no account matched', async () => {
    // Skipping it would make the unknown-account path measurably faster and
    // give away what the message withholds.
    await expectRejection({ ...credentials, identifier: 'nobody@example.test' });
    expect(hasher.verifyCalls).toHaveLength(1);
  });

  it('verifies against a real hash, not a placeholder that fails instantly', async () => {
    await expectRejection({ ...credentials, identifier: 'nobody@example.test' });
    expect(hasher.verifyCalls[0]).toMatch(/^hashed:/);
  });

  it('reuses the decoy hash rather than deriving one per attempt', async () => {
    for (let i = 0; i < 3; i += 1) {
      await expectRejection({ ...credentials, identifier: `nobody${i}@example.test` });
    }
    // Derived once. Otherwise every failed sign-in would cost an extra
    // key derivation, which is a denial-of-service lever.
    expect(hasher.hashCalls).toBe(1);
  });

  it('issues no session for a failed attempt', async () => {
    await expectRejection({ ...credentials, password: 'wrong-password' });
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('does not log which account was attempted', async () => {
    const lines: string[] = [];
    const capturing = pino({ level: 'info' }, {
      write(line: string) {
        lines.push(line);
      },
    } as unknown as NodeJS.WritableStream);

    await new AuthenticationService(
      users as unknown as UserRepository,
      sessions as unknown as SessionService,
      hasher,
      capturing,
    )
      .login({ ...credentials, password: 'wrong-password' })
      .catch(() => undefined);

    const combined = lines.join('\n');
    expect(combined).toContain('sign-in attempt failed');
    // Someone who can read logs should not get the answer the response withheld.
    expect(combined).not.toContain('ada@example.test');
    expect(combined).not.toContain('user-1');
  });
});

describe('upgrading a stored hash', () => {
  it('rehashes when the stored parameters are below policy', async () => {
    hasher.rehashNeeded = true;
    await service.login(credentials);

    expect(users.updatedHashes).toHaveLength(1);
    expect(users.updatedHashes[0]?.id).toBe('user-1');
  });

  it('leaves a current hash alone', async () => {
    await service.login(credentials);
    expect(users.updatedHashes).toHaveLength(0);
  });

  it('does not rehash for a failed sign-in', async () => {
    hasher.rehashNeeded = true;
    await service.login({ ...credentials, password: 'wrong' }).catch(() => undefined);
    expect(users.updatedHashes).toHaveLength(0);
  });

  it('still signs the user in when the upgrade write fails', async () => {
    // The credentials were correct. Failing the sign-in because an
    // optimisation failed would be the wrong trade.
    hasher.rehashNeeded = true;
    users.updateShouldFail = true;
    await expect(service.login(credentials)).resolves.toBeDefined();
  });
});
