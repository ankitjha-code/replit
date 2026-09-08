import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { MessageBudget, SocketGuard } from './socket-guard.js';

const guard = (maxPerUser = 2, maxAttempts = 3) =>
  new SocketGuard({
    maxPerUser,
    maxAttempts,
    attemptWindowMs: 60_000,
    log: pino({ level: 'silent' }),
  });

describe('sockets per account', () => {
  it('refuses once an account holds as many as it may', () => {
    const instance = guard(2);
    expect(instance.acquire('u1').ok).toBe(true);
    expect(instance.acquire('u1').ok).toBe(true);
    expect(instance.acquire('u1')).toMatchObject({ ok: false, status: 429 });
  });

  it('gives the slot back on release, and only once however often it is released', () => {
    // A close, an error and a shutdown can all arrive for one socket. Freeing
    // two slots for it would let an account exceed its ceiling for ever after.
    const instance = guard(1);
    const first = instance.acquire('u1');
    if (!first.ok) throw new Error('expected a slot');

    first.release();
    first.release();
    first.release();
    expect(instance.heldBy('u1')).toBe(0);

    expect(instance.acquire('u1').ok).toBe(true);
    expect(instance.acquire('u1').ok).toBe(false);
  });

  it('keeps accounts apart', () => {
    const instance = guard(1);
    expect(instance.acquire('u1').ok).toBe(true);
    expect(instance.acquire('u2').ok).toBe(true);
  });
});

describe('upgrade attempts', () => {
  it('refuses an address that tries too often, and counts refused attempts too', () => {
    const instance = guard(10, 3);
    expect([1, 2, 3].map(() => instance.mayAttempt('198.51.100.7'))).toEqual([true, true, true]);
    expect(instance.mayAttempt('198.51.100.7')).toBe(false);
    expect(instance.mayAttempt('198.51.100.8')).toBe(true);
  });
});

describe('messages on a socket', () => {
  it('admits a burst and then drops what exceeds it', () => {
    const budget = new MessageBudget(3, 0);
    expect([1, 2, 3, 4].map(() => budget.take())).toEqual([true, true, true, false]);
  });
});
