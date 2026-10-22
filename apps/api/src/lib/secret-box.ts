import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors/app-error.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretBox {
  seal(plaintext: string): Buffer;
  open(sealed: Uint8Array): string;
}

export function parseEncryptionKey(configured: string | undefined): Buffer | undefined {
  if (!configured) return undefined;

  const key = Buffer.from(configured, 'base64');

  if (key.byteLength !== KEY_BYTES) {
    throw new Error(
      `SECRETS_ENCRYPTION_KEY must be ${KEY_BYTES} bytes encoded as base64; got ${key.byteLength}`,
    );
  }

  return key;
}

export function createSecretBox(key: Buffer): SecretBox {
  return {
    seal(plaintext: string): Buffer {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, nonce);

      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    },

    open(sealed: Uint8Array): string {
      const buffer = Buffer.from(sealed);

      if (buffer.byteLength <= NONCE_BYTES + TAG_BYTES) {
        throw corrupt();
      }

      const nonce = buffer.subarray(0, NONCE_BYTES);
      const tag = buffer.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
      const ciphertext = buffer.subarray(NONCE_BYTES + TAG_BYTES);

      const decipher = createDecipheriv(ALGORITHM, key, nonce);
      decipher.setAuthTag(tag);

      try {
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch {
        throw corrupt();
      }
    },
  };
}

export interface KeyRing extends SecretBox {
  isCurrent(sealed: Uint8Array): boolean;
}

export function createKeyRing(current: Buffer, previous: readonly Buffer[] = []): KeyRing {
  const primary = createSecretBox(current);
  const older = previous.map((key) => createSecretBox(key));

  return {
    seal: (plaintext) => primary.seal(plaintext),

    open(sealed) {
      try {
        return primary.open(sealed);
      } catch (error) {
        for (const box of older) {
          try {
            return box.open(sealed);
          } catch {}
        }
        throw error;
      }
    },

    isCurrent(sealed) {
      try {
        primary.open(sealed);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function parsePreviousKeys(configured: string | undefined): Buffer[] {
  if (!configured) return [];
  return configured
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => parseEncryptionKey(value)!);
}

export function sameKey(a: Buffer, b: Buffer): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function corrupt(): AppError {
  return new AppError(
    'INTERNAL_ERROR',
    'A stored value could not be read back. It may have been set with a different encryption key.',
    { expose: true },
  );
}
