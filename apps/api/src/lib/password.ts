import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing.
 *
 * An interface rather than free functions for two reasons: tests substitute a
 * cheap implementation so a suite is not spent burning CPU on key derivation,
 * and the parameters can be raised later without every call site knowing.
 */
export interface PasswordHasher {
  hash(plaintext: string): Promise<string>;
  /** Constant-time within Argon2 itself; never compares strings directly. */
  verify(hashValue: string, plaintext: string): Promise<boolean>;
  /** True when a stored hash used weaker parameters than the current policy. */
  needsRehash(hashValue: string): boolean;
}

/**
 * The library declares its Algorithm enum as an ambient const enum, which
 * cannot be imported as a value under `verbatimModuleSyntax`. The variant is
 * named here rather than left as a bare 2 at the call site, and a test asserts
 * the produced hash really is argon2id.
 */
const ARGON2ID = 2;

/**
 * OWASP's Argon2id baseline: 19 MiB of memory, two passes, one lane.
 *
 * Memory cost is the parameter that matters against GPU attacks, and it is
 * also the one that bounds concurrency here: every simultaneous registration
 * or login holds this much memory for the duration of the hash. Raising it
 * without raising the request rate limit alongside would turn login into a
 * memory-exhaustion vector against ourselves.
 */
export const ARGON2_PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

class Argon2Hasher implements PasswordHasher {
  hash(plaintext: string): Promise<string> {
    return hash(plaintext, ARGON2_PARAMS);
  }

  async verify(hashValue: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(hashValue, plaintext, ARGON2_PARAMS);
    } catch {
      // A malformed or truncated stored hash is a failed verification, not a
      // crash. Throwing here would turn a corrupt row into a 500 that also
      // tells the caller the account exists.
      return false;
    }
  }

  needsRehash(hashValue: string): boolean {
    const parsed = parseArgon2Parameters(hashValue);
    if (!parsed) return true;

    return (
      parsed.algorithm !== 'argon2id' ||
      parsed.memoryCost < ARGON2_PARAMS.memoryCost ||
      parsed.timeCost < ARGON2_PARAMS.timeCost
    );
  }
}

interface Argon2Parameters {
  algorithm: string;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

/**
 * Reads the parameters Argon2 encodes into its own output, e.g.
 * `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`.
 */
export function parseArgon2Parameters(hashValue: string): Argon2Parameters | undefined {
  const match = /^\$(argon2[a-z]+)\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hashValue);
  if (!match) return undefined;

  const [, algorithm, memory, time, lanes] = match;
  return {
    algorithm: algorithm!,
    memoryCost: Number(memory),
    timeCost: Number(time),
    parallelism: Number(lanes),
  };
}

export function createPasswordHasher(): PasswordHasher {
  return new Argon2Hasher();
}
