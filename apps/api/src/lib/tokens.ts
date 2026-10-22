import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque session tokens.
 *
 * The browser holds a random string; the database holds only its SHA-256. A
 * dump of the sessions table therefore cannot be replayed to impersonate
 * anyone, which is the whole reason for storing a digest rather than the token.
 *
 * SHA-256 is right here and Argon2 would be wrong. Password hashing must be
 * slow because passwords are low-entropy and guessable. A 256-bit random token
 * is not guessable, so the only requirement is a fast one-way function; making
 * lookup slow would just add a key derivation to every authenticated request.
 */

/** 32 bytes of entropy. Brute force is not a consideration at this size. */
const TOKEN_BYTES = 32;

/** SHA-256 rendered as lowercase hex. The column is CHAR(64) to match. */
export const TOKEN_HASH_LENGTH = 64;

export function generateSessionToken(): string {
  // base64url so the value is safe in a cookie without further escaping.
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Compares two hex digests without leaking, through timing, how many leading
 * characters matched.
 *
 * Session lookup is by indexed equality on the digest, so this is not on the
 * critical path today. It exists for the comparisons that are, and so that a
 * future direct comparison does not reintroduce the leak.
 */
export function tokenHashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** True when a value could be a token this system issued. Cheap pre-filter. */
export function looksLikeSessionToken(value: string): boolean {
  // base64url of 32 bytes is 43 characters, with no padding.
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}
