import { describe, expect, it } from 'vitest';
import {
  MAX_VARIABLE_VALUE_LENGTH,
  setVariableRequestSchema,
  variableKeySchema,
  variableValueSchema,
} from './variables.js';
import { secretValueSchema } from './secrets.js';

/**
 * The rules for a plain environment variable.
 *
 * Names follow the same rules as secrets, because both end up in the same
 * environment and a name is legal or not regardless of which side set it.
 * Values do not, and the differences are the interesting part.
 */

describe('names', () => {
  it('accepts the shape a shell requires', () => {
    for (const key of ['PORT', 'LOG_LEVEL', '_PRIVATE', 'A1', 'X_2_Y']) {
      expect(variableKeySchema.safeParse(key).success).toBe(true);
    }
  });

  it('refuses what a shell could not use', () => {
    for (const key of ['lower', 'has-dash', 'has space', '1LEADING', 'has.dot', '']) {
      expect(variableKeySchema.safeParse(key).success).toBe(false);
    }
  });

  it('refuses names that change how a process loads code', () => {
    // The container is isolated either way. This is about a runtime that
    // behaves predictably rather than about protecting the platform.
    for (const key of ['PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'HOME', 'IFS']) {
      expect(variableKeySchema.safeParse(key).success).toBe(false);
    }
  });

  it('refuses a reserved name whatever case it is written in', () => {
    expect(variableKeySchema.safeParse('path').success).toBe(false);
  });

  it('trims surrounding space rather than storing a name nobody can reach', () => {
    const result = variableKeySchema.safeParse('  PORT  ');
    expect(result.success && result.data).toBe('PORT');
  });

  it('says which rule was broken, so the message is worth showing', () => {
    const result = variableKeySchema.safeParse('lower');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/capital letters/i);
    }
  });
});

describe('values', () => {
  it('accepts ordinary configuration', () => {
    for (const value of ['8080', 'debug', 'postgres://localhost/db', 'a,b,c']) {
      expect(variableValueSchema.safeParse(value).success).toBe(true);
    }
  });

  it('accepts an empty value, unlike a secret', () => {
    /*
     * The one place the two disagree about what is acceptable.
     *
     * Most programs distinguish a variable set to nothing from one that is not
     * set at all, so an empty variable is ordinary. An empty secret is only
     * ever a mistake: nobody means to store a credential of no length.
     */
    expect(variableValueSchema.safeParse('').success).toBe(true);
    expect(secretValueSchema.safeParse('').success).toBe(false);
  });

  it('accepts a value with newlines in it', () => {
    expect(variableValueSchema.safeParse('one\ntwo').success).toBe(true);
  });

  it('refuses a null byte, which cannot survive the boundary into a process', () => {
    const nul = String.fromCharCode(0);
    expect(variableValueSchema.safeParse(`a${nul}b`).success).toBe(false);
  });

  it('is bounded, because every one is passed to a container at start', () => {
    expect(variableValueSchema.safeParse('x'.repeat(MAX_VARIABLE_VALUE_LENGTH)).success).toBe(true);
    expect(variableValueSchema.safeParse('x'.repeat(MAX_VARIABLE_VALUE_LENGTH + 1)).success).toBe(
      false,
    );
  });

  it('is bounded more tightly than a secret, which may be a whole key', () => {
    expect(MAX_VARIABLE_VALUE_LENGTH).toBeLessThan(16 * 1024);
  });
});

describe('the request', () => {
  it('needs both a name and a value', () => {
    expect(setVariableRequestSchema.safeParse({ key: 'PORT', value: '80' }).success).toBe(true);
    expect(setVariableRequestSchema.safeParse({ key: 'PORT' }).success).toBe(false);
    expect(setVariableRequestSchema.safeParse({ value: '80' }).success).toBe(false);
  });

  it('rejects a bad name even when the value is fine', () => {
    expect(setVariableRequestSchema.safeParse({ key: 'bad name', value: '80' }).success).toBe(
      false,
    );
  });
});
