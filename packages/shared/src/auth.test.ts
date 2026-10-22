import { describe, expect, it } from 'vitest';
import {
  RESERVED_USERNAMES,
  normalizeEmail,
  passwordSchema,
  registerRequestSchema,
  usernameSchema,
} from './auth.js';

const valid = {
  email: 'ada@example.test',
  username: 'ada-lovelace',
  password: 'analytical-engine-1843',
};

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Ada@Example.TEST ')).toBe('ada@example.test');
  });

  it('leaves plus-addressing and dots alone', () => {
    // Those rules are provider-specific; applying them everywhere would merge
    // accounts belonging to different people.
    expect(normalizeEmail('a.d.a+work@example.test')).toBe('a.d.a+work@example.test');
  });
});

describe('username rules', () => {
  it('accepts letters, digits and internal hyphens', () => {
    for (const name of ['ada', 'ada-lovelace', 'user123', 'a-b-c']) {
      expect(usernameSchema.safeParse(name).success).toBe(true);
    }
  });

  it('rejects leading, trailing and doubled hyphens', () => {
    for (const name of ['-ada', 'ada-', 'ada--lovelace']) {
      expect(usernameSchema.safeParse(name).success).toBe(false);
    }
  });

  it('rejects characters that would need escaping in a URL or hostname', () => {
    for (const name of ['ada lovelace', 'ada/lovelace', 'ada.lovelace', 'ada_lovelace', 'adaá']) {
      expect(usernameSchema.safeParse(name).success).toBe(false);
    }
  });

  it('rejects names that would shadow platform routes', () => {
    for (const name of ['api', 'admin', 'health', 'preview', 'settings', 'ws']) {
      expect(usernameSchema.safeParse(name).success).toBe(false);
    }
  });

  it('rejects a reserved name regardless of case', () => {
    expect(usernameSchema.safeParse('AdMiN').success).toBe(false);
  });

  it('reserves every name the proxy and routes actually use', () => {
    for (const name of ['api', 'health', 'ws', 'preview', 'app', 'assets']) {
      expect(RESERVED_USERNAMES.has(name)).toBe(true);
    }
  });

  it('enforces length bounds', () => {
    expect(usernameSchema.safeParse('ab').success).toBe(false);
    expect(usernameSchema.safeParse('a'.repeat(39)).success).toBe(true);
    expect(usernameSchema.safeParse('a'.repeat(40)).success).toBe(false);
  });
});

describe('password rules', () => {
  it('accepts a long passphrase without composition rules', () => {
    expect(passwordSchema.safeParse('correct horse battery staple').success).toBe(true);
  });

  it('rejects anything shorter than the minimum', () => {
    expect(passwordSchema.safeParse('short1').success).toBe(false);
  });

  it('rejects an unbounded password that would waste hashing work', () => {
    expect(passwordSchema.safeParse('a'.repeat(201)).success).toBe(false);
  });

  it('rejects passwords tried first in any attack', () => {
    expect(passwordSchema.safeParse('password123').success).toBe(false);
    expect(passwordSchema.safeParse('QWERTYUIOP').success).toBe(false);
  });
});

describe('registration request', () => {
  it('accepts a valid registration', () => {
    expect(registerRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    const parsed = registerRequestSchema.parse({ ...valid, email: '  ada@example.test ' });
    expect(parsed.email).toBe('ada@example.test');
  });

  it('rejects a password containing the username', () => {
    const result = registerRequestSchema.safeParse({
      ...valid,
      password: 'my-ada-lovelace-password',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['password']);
  });

  it('rejects a password containing the email local part', () => {
    const result = registerRequestSchema.safeParse({
      email: 'lovelace@example.test',
      username: 'ada',
      password: 'lovelace-secret-99',
    });
    expect(result.success).toBe(false);
  });

  it('does not reject on a very short email local part', () => {
    // "ab" appearing inside a passphrase is coincidence, not reuse.
    expect(
      registerRequestSchema.safeParse({
        email: 'ab@example.test',
        username: 'someone',
        password: 'absolutely-fine-passphrase',
      }).success,
    ).toBe(true);
  });

  it('rejects a malformed email', () => {
    expect(registerRequestSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(
      false,
    );
  });

  it('treats displayName as optional', () => {
    expect(registerRequestSchema.safeParse({ ...valid, displayName: 'Ada' }).success).toBe(true);
    expect(registerRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('drops extra fields rather than passing them through', () => {
    const parsed = registerRequestSchema.parse({ ...valid, isAdmin: true });
    expect('isAdmin' in parsed).toBe(false);
  });
});
