import { hash, verify } from '@node-rs/argon2';

export interface PasswordHasher {
  hash(plaintext: string): Promise<string>;
  verify(hashValue: string, plaintext: string): Promise<boolean>;
  needsRehash(hashValue: string): boolean;
}

const ARGON2ID = 2;

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
