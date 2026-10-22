import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSecretBox, parseEncryptionKey, sameKey } from './secret-box.js';

const key = randomBytes(32);
const box = createSecretBox(key);

describe('the key', () => {
  it('accepts thirty-two bytes as base64', () => {
    const parsed = parseEncryptionKey(randomBytes(32).toString('base64'));
    expect(parsed?.byteLength).toBe(32);
  });

  it('reports no key rather than inventing one', () => {
    expect(parseEncryptionKey(undefined)).toBeUndefined();
    expect(parseEncryptionKey('')).toBeUndefined();
  });

  it('refuses a key of the wrong size, at startup', () => {
    expect(() => parseEncryptionKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => parseEncryptionKey('not base64 at all!!')).toThrow();
  });

  it('compares two keys without saying how nearly they match', () => {
    const other = randomBytes(32);
    expect(sameKey(key, Buffer.from(key))).toBe(true);
    expect(sameKey(key, other)).toBe(false);
    expect(sameKey(key, randomBytes(16))).toBe(false);
  });
});

describe('sealing and opening', () => {
  it('round-trips a value', () => {
    expect(box.open(box.seal('a-real-api-key'))).toBe('a-real-api-key');
  });

  it('round-trips characters that are not ASCII', () => {
    expect(box.open(box.seal('pässwörd ✓ 🔐'))).toBe('pässwörd ✓ 🔐');
  });

  it('produces different output for the same value every time', () => {
    const first = box.seal('same value');
    const second = box.seal('same value');

    expect(first.equals(second)).toBe(false);
    expect(box.open(first)).toBe(box.open(second));
  });

  it('never contains the value it was given', () => {
    const sealed = box.seal('super-secret-token');
    expect(sealed.toString('utf8')).not.toContain('super-secret-token');
    expect(sealed.toString('latin1')).not.toContain('super-secret-token');
  });
});

describe('when a stored value has been tampered with', () => {
  it('refuses a ciphertext that was altered', () => {
    const sealed = flip(box.seal('original'), -1);

    expect(() => box.open(sealed)).toThrow(/could not be read back/);
  });

  it('refuses a value whose nonce was altered', () => {
    expect(() => box.open(flip(box.seal('original'), 0))).toThrow();
  });

  it('refuses a value sealed with a different key', () => {
    const other = createSecretBox(randomBytes(32));
    expect(() => box.open(other.seal('elsewhere'))).toThrow();
  });

  it('refuses something too short to be a sealed value', () => {
    expect(() => box.open(Buffer.alloc(4))).toThrow();
    expect(() => box.open(Buffer.alloc(0))).toThrow();
  });

  it('says the same thing whichever way it failed', () => {
    const altered = flip(box.seal('a'), -1);
    const wrongKey = createSecretBox(randomBytes(32)).seal('a');

    const first = getMessage(() => box.open(altered));
    const second = getMessage(() => box.open(wrongKey));

    expect(first).toBe(second);
  });
});

function getMessage(work: () => unknown): string {
  try {
    work();
    return 'no error';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function flip(sealed: Buffer, index: number): Buffer {
  const at = index < 0 ? sealed.length + index : index;
  sealed.writeUInt8(sealed.readUInt8(at) ^ 0xff, at);
  return sealed;
}
