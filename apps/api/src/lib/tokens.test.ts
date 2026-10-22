import { describe, expect, it } from 'vitest';
import {
  TOKEN_HASH_LENGTH,
  generateSessionToken,
  hashToken,
  looksLikeSessionToken,
  tokenHashesEqual,
} from './tokens.js';

describe('generateSessionToken', () => {
  it('produces a URL-safe value that needs no escaping in a cookie', () => {
    expect(generateSessionToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('carries 32 bytes of entropy', () => {
    // base64url of 32 bytes, unpadded.
    expect(generateSessionToken()).toHaveLength(43);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 500 }, generateSessionToken));
    expect(tokens.size).toBe(500);
  });
});

describe('hashToken', () => {
  it('produces a fixed-length hex digest matching the column width', () => {
    const digest = hashToken(generateSessionToken());
    expect(digest).toHaveLength(TOKEN_HASH_LENGTH);
    expect(digest).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic, so a token can be looked up by its digest', () => {
    const token = generateSessionToken();
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it('never contains the token it was derived from', () => {
    const token = generateSessionToken();
    expect(hashToken(token)).not.toContain(token);
  });

  it('changes completely for a one-character difference', () => {
    const a = hashToken('token-a');
    const b = hashToken('token-b');
    expect(a).not.toBe(b);
  });
});

describe('tokenHashesEqual', () => {
  it('matches identical digests', () => {
    const digest = hashToken('x');
    expect(tokenHashesEqual(digest, digest)).toBe(true);
  });

  it('rejects different digests', () => {
    expect(tokenHashesEqual(hashToken('a'), hashToken('b'))).toBe(false);
  });

  it('rejects differing lengths without throwing', () => {
    // A raw timingSafeEqual would throw on a length mismatch, turning a
    // malformed input into a 500.
    expect(tokenHashesEqual('short', hashToken('a'))).toBe(false);
    expect(tokenHashesEqual('', '')).toBe(true);
  });
});

describe('looksLikeSessionToken', () => {
  it('accepts a token this system issued', () => {
    expect(looksLikeSessionToken(generateSessionToken())).toBe(true);
  });

  it('rejects values that cannot be one, before any database work', () => {
    for (const value of ['', 'short', 'a'.repeat(44), 'has spaces in it', 'has+slash/chars=']) {
      expect(looksLikeSessionToken(value)).toBe(false);
    }
  });
});
