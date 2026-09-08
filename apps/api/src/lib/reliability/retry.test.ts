import { describe, expect, it, vi } from 'vitest';
import { isTransientNetworkError, withRetry } from './retry.js';

const fast = { attempts: 3, baseMs: 1, maxMs: 2 };

describe('withRetry', () => {
  it('returns the first success without trying again', async () => {
    const work = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(work, { ...fast, isTransient: () => true })).resolves.toBe('ok');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and returns the eventual success', async () => {
    const work = vi.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValue('ok');
    await expect(withRetry(work, { ...fast, isTransient: () => true })).resolves.toBe('ok');
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('stops at the attempt ceiling and throws the last failure', async () => {
    const work = vi.fn().mockRejectedValue(new Error('still down'));
    await expect(withRetry(work, { ...fast, isTransient: () => true })).rejects.toThrow(
      'still down',
    );
    expect(work).toHaveBeenCalledTimes(3);
  });

  it('never repeats a failure the caller says is not transient', async () => {
    // The property the whole design rests on: a refused credential, or a write
    // that already happened, must not be tried again.
    const work = vi.fn().mockRejectedValue(new Error('forbidden'));
    await expect(withRetry(work, { ...fast, isTransient: () => false })).rejects.toThrow();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('tells the caller before each wait, with a delay inside the ceiling', async () => {
    const waits: number[] = [];
    const work = vi.fn().mockRejectedValue(new Error('down'));
    await withRetry(work, {
      attempts: 3,
      baseMs: 10,
      maxMs: 15,
      isTransient: () => true,
      onRetry: (_error, _attempt, delay) => waits.push(delay),
    }).catch(() => undefined);

    // Two waits for three attempts, each full-jittered inside its ceiling.
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(0);
    expect(waits[0]).toBeLessThanOrEqual(10);
    expect(waits[1]).toBeLessThanOrEqual(15);
  });
});

describe('isTransientNetworkError', () => {
  it.each(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'])('says yes to %s', (code) => {
    expect(isTransientNetworkError(Object.assign(new Error(code), { code }))).toBe(true);
  });

  it.each([502, 503, 504])('says yes to a %i', (statusCode) => {
    expect(isTransientNetworkError({ statusCode })).toBe(true);
  });

  // The negative cases matter more than the positive ones: saying yes too
  // generously is how a retry repeats something that already had an effect.
  it.each([500, 400, 403, 404])('says no to a %i', (statusCode) => {
    expect(isTransientNetworkError({ statusCode })).toBe(false);
  });

  it('says no to an ordinary error, and to things that are not errors', () => {
    expect(isTransientNetworkError(new Error('something'))).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError('ECONNRESET')).toBe(false);
  });
});
