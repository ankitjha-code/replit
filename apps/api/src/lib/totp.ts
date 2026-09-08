import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords, as authenticator apps produce them.
 *
 * RFC 6238 over RFC 4226: an HMAC of the number of thirty-second steps since the
 * epoch, cut down to six digits. Written here with the platform's own crypto
 * rather than taken from a package, because it is forty lines, it is checked
 * against the RFC's published test vectors, and a dependency in the sign-in path
 * is a dependency whose updates have to be trusted forever.
 *
 * SHA-1, 30 seconds, 6 digits: not because they are the strongest choices but
 * because they are the ones every authenticator app supports without asking.
 * The security of a TOTP code comes from its short life and from the attempt
 * limit around it, not from the hash.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** The time-step a moment falls in. */
export function stepAt(at: Date): number {
  return Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** The code for one time-step. */
export function codeFor(secret: Buffer, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const hmac = createHmac('sha1', secret).update(counter).digest();

  // Dynamic truncation, RFC 4226 §5.3.
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Which step a code matches, if any, allowing one step either side.
 *
 * One step of slack in each direction because phones' clocks drift and a person
 * types slowly; more would widen the window a stolen code is good for. Returns
 * the step so the caller can refuse it next time — a code must work once.
 */
export function matchingStep(secret: Buffer, code: string, at: Date): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;

  const now = stepAt(at);
  for (const step of [now - 1, now, now + 1]) {
    const expected = Buffer.from(codeFor(secret, step));
    const given = Buffer.from(code);
    if (expected.length === given.length && timingSafeEqual(expected, given)) return step;
  }
  return undefined;
}

/** A new shared secret: 20 bytes, the length RFC 4226 recommends for SHA-1. */
export function newSecret(): Buffer {
  return randomBytes(20);
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 without padding, which is how authenticator apps take a secret. */
export function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The link an authenticator app understands.
 *
 * The issuer and the account name are both encoded, and both appear in the
 * app, so a person can tell this platform's entry from the others on their
 * phone.
 */
export function otpauthUri(secret: Buffer, issuer: string, account: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: base32(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
