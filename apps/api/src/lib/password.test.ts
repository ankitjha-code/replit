import { describe, expect, it } from 'vitest';
import { ARGON2_PARAMS, createPasswordHasher, parseArgon2Parameters } from './password.js';

// Real key derivation is intentionally slow; these cases are few and deliberate.
const hasher = createPasswordHasher();

describe('password hashing', () => {
  it('verifies a password against its own hash', async () => {
    const stored = await hasher.hash('correct horse battery staple');
    await expect(hasher.verify(stored, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hasher.hash('correct horse battery staple');
    await expect(hasher.verify(stored, 'correct horse battery stapl')).resolves.toBe(false);
  });

  it('uses argon2id with the configured parameters', async () => {
    const stored = await hasher.hash('a-passphrase-for-parameters');
    const parsed = parseArgon2Parameters(stored);

    expect(parsed?.algorithm).toBe('argon2id');
    expect(parsed?.memoryCost).toBe(ARGON2_PARAMS.memoryCost);
    expect(parsed?.timeCost).toBe(ARGON2_PARAMS.timeCost);
  });

  it('salts each hash, so identical passwords do not collide', async () => {
    const [first, second] = await Promise.all([
      hasher.hash('same-password'),
      hasher.hash('same-password'),
    ]);
    expect(first).not.toBe(second);
    // Both still verify: the salt lives inside the hash.
    await expect(hasher.verify(first, 'same-password')).resolves.toBe(true);
    await expect(hasher.verify(second, 'same-password')).resolves.toBe(true);
  });

  it('never stores the plaintext inside the hash', async () => {
    const stored = await hasher.hash('plaintext-should-not-appear');
    expect(stored).not.toContain('plaintext-should-not-appear');
  });

  it('treats a corrupt stored hash as a failed verification, not a crash', async () => {
    // A 500 here would also tell the caller the account exists.
    await expect(hasher.verify('not-a-hash', 'anything')).resolves.toBe(false);
    await expect(hasher.verify('', 'anything')).resolves.toBe(false);
    await expect(hasher.verify('$argon2id$truncated', 'anything')).resolves.toBe(false);
  });

  it('handles unicode and very long passphrases', async () => {
    const passphrase = 'π-très-long-🔐-'.repeat(10);
    const stored = await hasher.hash(passphrase);
    await expect(hasher.verify(stored, passphrase)).resolves.toBe(true);
  });
});

describe('needsRehash', () => {
  it('accepts a hash produced with the current policy', async () => {
    const stored = await hasher.hash('a-current-policy-password');
    expect(hasher.needsRehash(stored)).toBe(false);
  });

  it('flags a hash with weaker memory or time cost', () => {
    expect(hasher.needsRehash('$argon2id$v=19$m=4096,t=2,p=1$salt$hash')).toBe(true);
    expect(hasher.needsRehash('$argon2id$v=19$m=19456,t=1,p=1$salt$hash')).toBe(true);
  });

  it('flags a hash from a different argon2 variant', () => {
    expect(hasher.needsRehash('$argon2i$v=19$m=19456,t=2,p=1$salt$hash')).toBe(true);
  });

  it('flags anything it cannot parse', () => {
    expect(hasher.needsRehash('$2b$12$bcrypt-style-hash')).toBe(true);
    expect(hasher.needsRehash('')).toBe(true);
  });
});

describe('parseArgon2Parameters', () => {
  it('reads the parameters argon2 encodes into its output', () => {
    expect(parseArgon2Parameters('$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA')).toEqual({
      algorithm: 'argon2id',
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
  });

  it('returns undefined for a non-argon2 hash', () => {
    expect(parseArgon2Parameters('$2b$12$something')).toBeUndefined();
  });
});
