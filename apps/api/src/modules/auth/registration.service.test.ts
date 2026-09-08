import { pino } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisterRequest } from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import type { PasswordHasher } from '../../lib/password.js';
import type {
  CreateUserInput,
  CreateUserResult,
  UserRepository,
} from '../users/user.repository.js';
import { RegistrationService } from './registration.service.js';

const silent = pino({ level: 'silent' });

/**
 * An in-memory stand-in for the repository.
 *
 * The service's job is policy: normalisation, ordering, duplicate handling.
 * None of that needs a database to verify, and testing it without one means
 * these cases run in milliseconds and cannot pass for the wrong reason
 * because of a leftover row.
 */
class FakeUserRepository {
  readonly rows: CreateUserInput[] = [];
  /** Simulates a concurrent registration winning the race. */
  raceConflict: 'email' | 'username' | 'unknown' | undefined;

  create = vi.fn(async (input: CreateUserInput): Promise<CreateUserResult> => {
    if (this.raceConflict) {
      const conflict = this.raceConflict;
      this.raceConflict = undefined;
      return { ok: false, conflict };
    }
    this.rows.push(input);
    return {
      ok: true,
      user: {
        id: '018f0000-0000-7000-8000-000000000001',
        email: input.email,
        username: input.username,
        passwordHash: input.passwordHash,
        displayName: input.displayName ?? null,
        emailVerifiedAt: null,
        isOperator: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    };
  });

  existsByEmailOrUsername = vi.fn(async (email: string, username: string) => ({
    email: this.rows.some((r) => r.email === email),
    username: this.rows.some((r) => r.username.toLowerCase() === username.toLowerCase()),
  }));
}

class CountingHasher implements PasswordHasher {
  calls = 0;
  hash(plaintext: string): Promise<string> {
    this.calls += 1;
    return Promise.resolve(`hashed:${plaintext}`);
  }
  verify(): Promise<boolean> {
    return Promise.resolve(true);
  }
  needsRehash(): boolean {
    return false;
  }
}

const request = (overrides: Partial<RegisterRequest> = {}): RegisterRequest => ({
  email: 'ada@example.test',
  username: 'ada',
  password: 'analytical-engine-1843',
  ...overrides,
});

let repository: FakeUserRepository;
let hasher: CountingHasher;
let service: RegistrationService;

beforeEach(() => {
  repository = new FakeUserRepository();
  hasher = new CountingHasher();
  service = new RegistrationService(repository as unknown as UserRepository, hasher, silent);
});

describe('registration', () => {
  it('creates an account and returns the public view of it', async () => {
    const user = await service.register(request({ displayName: 'Ada' }));

    expect(user.username).toBe('ada');
    expect(user.displayName).toBe('Ada');
    expect(user.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('never returns the password hash', async () => {
    const user = await service.register(request());
    expect(JSON.stringify(user)).not.toContain('hashed:');
    expect('passwordHash' in user).toBe(false);
  });

  it('stores a hash, never the plaintext', async () => {
    await service.register(request());
    expect(repository.rows[0]?.passwordHash).toBe('hashed:analytical-engine-1843');
    expect(repository.rows[0]?.passwordHash).not.toBe('analytical-engine-1843');
  });

  it('normalises the email before storing it', async () => {
    await service.register(request({ email: '  ADA@Example.TEST  ' }));
    expect(repository.rows[0]?.email).toBe('ada@example.test');
  });

  it('preserves username casing as typed', async () => {
    // The display form is the user's choice; uniqueness is enforced
    // case-insensitively regardless.
    await service.register(request({ username: 'AdaLovelace' }));
    expect(repository.rows[0]?.username).toBe('AdaLovelace');
  });

  it('rejects a duplicate email with a field-specific conflict', async () => {
    await service.register(request());
    const error = (await service
      .register(request({ username: 'other' }))
      .catch((e) => e)) as AppError;

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('CONFLICT');
    expect(error.details).toEqual({ field: 'email' });
  });

  it('rejects a duplicate username regardless of case', async () => {
    await service.register(request({ username: 'Ada' }));
    const error = (await service
      .register(request({ email: 'other@example.test', username: 'ADA' }))
      .catch((e) => e)) as AppError;

    expect(error.code).toBe('CONFLICT');
    expect(error.details).toEqual({ field: 'username' });
  });

  it('does not hash a password for a registration it is going to reject', async () => {
    await service.register(request());
    const before = hasher.calls;

    await service.register(request({ username: 'other' })).catch(() => undefined);

    // Hashing costs 19 MiB and real time. Doing it for a known-duplicate
    // registration would let anyone burn server resources at will.
    expect(hasher.calls).toBe(before);
  });

  it('honours the database when it loses a race to a concurrent registration', async () => {
    // The pre-check passes for both requests; the unique constraint is what
    // actually prevents the duplicate.
    repository.raceConflict = 'email';
    const error = (await service.register(request()).catch((e) => e)) as AppError;

    expect(error.code).toBe('CONFLICT');
    expect(error.details).toEqual({ field: 'email' });
  });

  it('reports an unattributable conflict without guessing a field', async () => {
    repository.raceConflict = 'unknown';
    const error = (await service.register(request()).catch((e) => e)) as AppError;

    expect(error.code).toBe('CONFLICT');
    expect(error.details).toBeUndefined();
  });

  it('stores a null display name when none is given', async () => {
    const user = await service.register(request());
    expect(user.displayName).toBeNull();
  });

  it('checks for duplicates before hashing', async () => {
    const order: string[] = [];
    repository.existsByEmailOrUsername.mockImplementation(async () => {
      order.push('check');
      return { email: false, username: false };
    });
    const trackingHasher: PasswordHasher = {
      hash: async (p) => {
        order.push('hash');
        return `hashed:${p}`;
      },
      verify: async () => true,
      needsRehash: () => false,
    };

    await new RegistrationService(
      repository as unknown as UserRepository,
      trackingHasher,
      silent,
    ).register(request());

    expect(order).toEqual(['check', 'hash']);
  });
});

describe('registration logging', () => {
  it('logs the user id and nothing identifying', async () => {
    const lines: string[] = [];
    const capturing = pino({ level: 'info' }, {
      write(line: string) {
        lines.push(line);
      },
    } as unknown as NodeJS.WritableStream);

    await new RegistrationService(
      repository as unknown as UserRepository,
      hasher,
      capturing,
    ).register(request());

    const combined = lines.join('\n');
    expect(combined).toContain('user registered');
    expect(combined).not.toContain('ada@example.test');
    expect(combined).not.toContain('analytical-engine-1843');
  });
});
