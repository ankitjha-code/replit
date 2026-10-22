import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32;

export const TOKEN_HASH_LENGTH = 64;

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenHashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function looksLikeSessionToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}
