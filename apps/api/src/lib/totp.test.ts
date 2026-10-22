import { describe, expect, it } from 'vitest';
import { base32, codeFor, matchingStep, stepAt } from './totp.js';

// RFC 6238 Appendix B: the SHA-1 seed and its published eight-digit codes.
const SEED = Buffer.from('12345678901234567890', 'ascii');
const VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP', () => {
  it.each(VECTORS)('matches the RFC 6238 vector at %i seconds', (seconds, expected) => {
    expect(codeFor(SEED, stepAt(new Date(seconds * 1000)), 8)).toBe(expected);
  });

  it('accepts the current code and one step either side, and nothing further', () => {
    const at = new Date(1_700_000_000_000);
    const now = stepAt(at);
    for (const offset of [-1, 0, 1]) {
      expect(matchingStep(SEED, codeFor(SEED, now + offset), at)).toBe(now + offset);
    }
    expect(matchingStep(SEED, codeFor(SEED, now + 2), at)).toBeUndefined();
    expect(matchingStep(SEED, codeFor(SEED, now - 2), at)).toBeUndefined();
  });

  it('refuses anything that is not six digits without comparing', () => {
    expect(matchingStep(SEED, '12345', new Date())).toBeUndefined();
    expect(matchingStep(SEED, 'abcdef', new Date())).toBeUndefined();
  });

  it('encodes base32 the way authenticator apps read it', () => {
    // RFC 4648 test vector.
    expect(base32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });
});
