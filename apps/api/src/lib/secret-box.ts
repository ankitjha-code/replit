import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors/app-error.js';

/**
 * Encryption for values the platform stores and never shows anyone.
 *
 * AES-256-GCM. Authenticated encryption rather than plain encryption, because
 * the threat is not only someone reading the database: a value altered there
 * must fail to decrypt rather than quietly becoming a different value that a
 * container is then handed.
 *
 * The stored form is one blob: nonce, then tag, then ciphertext. Keeping them
 * together means they cannot be separated by a schema change or by a partial
 * write, and there is no way to store a ciphertext whose nonce went missing.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
/** 96 bits, which is what GCM is specified for and what its security proof assumes. */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretBox {
  seal(plaintext: string): Buffer;
  open(sealed: Uint8Array): string;
}

/**
 * Reads the configured key.
 *
 * Returns undefined when there is none, which is a state the platform reports
 * rather than works around: an installation with no key cannot store secrets,
 * and inventing one per process would encrypt values that no later process
 * could read.
 */
export function parseEncryptionKey(configured: string | undefined): Buffer | undefined {
  if (!configured) return undefined;

  const key = Buffer.from(configured, 'base64');

  if (key.byteLength !== KEY_BYTES) {
    // Thrown at startup rather than at the first write. An installation
    // configured with an unusable key should not accept secrets for an hour
    // and then fail.
    throw new Error(
      `SECRETS_ENCRYPTION_KEY must be ${KEY_BYTES} bytes encoded as base64; got ${key.byteLength}`,
    );
  }

  return key;
}

export function createSecretBox(key: Buffer): SecretBox {
  return {
    seal(plaintext: string): Buffer {
      // A fresh nonce every time. Reusing one under the same key is the single
      // mistake that breaks GCM completely.
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
        // Either the value was altered or the key changed. Both are the same
        // answer to the caller, and neither says which.
        throw corrupt();
      }
    },
  };
}

/**
 * A current key and the keys it replaced.
 *
 * ## Why this exists
 *
 * A leaked encryption key used to be unrecoverable: every stored secret was
 * sealed with it, and changing the setting made every one of them unreadable.
 * Rotation needs two keys in play at once — the new one for everything written
 * from now on, and the old one for reading what was written before.
 *
 * **New values are always sealed with the current key.** Previous keys are only
 * ever used to open, and only until the re-encryption command has re-sealed
 * everything; after that they can be deleted from configuration.
 *
 * No format change was needed. GCM's authentication tag makes opening with the
 * wrong key fail cleanly rather than produce garbage, so trying each key in turn
 * is safe — and every value already stored, which carries no key identifier,
 * keeps working.
 */
export interface KeyRing extends SecretBox {
  /** Whether a value was sealed with the current key, for the rotation command. */
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
          } catch {
            // Not this one; try the next.
          }
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

/** Parses the previous keys, each with the same checks as the current one. */
export function parsePreviousKeys(configured: string | undefined): Buffer[] {
  if (!configured) return [];
  return configured
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => parseEncryptionKey(value)!);
}

/**
 * Whether two keys are the same, without leaking how nearly.
 *
 * Used when checking a rotation, where a comparison that returns early would
 * say how many leading bytes matched.
 */
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
