import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';

function breaker(threshold = 3, resetAfterMs = 1_000) {
  let now = 0;
  const instance = new CircuitBreaker({
    name: 'test',
    threshold,
    resetAfterMs,
    log: pino({ level: 'silent' }),
    now: () => now,
  });
  return { instance, advance: (ms: number) => (now += ms) };
}

const fail = () => Promise.reject(new Error('down'));
const succeed = () => Promise.resolve('ok');

describe('the circuit breaker', () => {
  it('opens after a run of failures and then refuses without calling', async () => {
    const { instance } = breaker(3);
    for (let i = 0; i < 3; i += 1) await instance.run(fail).catch(() => undefined);

    expect(instance.status).toBe('open');

    let called = false;
    await expect(
      instance.run(() => {
        called = true;
        return succeed();
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });

  it('counts a run, not a total: a success in between resets it', async () => {
    const { instance } = breaker(3);
    await instance.run(fail).catch(() => undefined);
    await instance.run(fail).catch(() => undefined);
    await instance.run(succeed);
    await instance.run(fail).catch(() => undefined);
    await instance.run(fail).catch(() => undefined);

    expect(instance.status).toBe('closed');
  });

  it('lets exactly one call through once it has cooled off', async () => {
    const { instance, advance } = breaker(1, 1_000);
    await instance.run(fail).catch(() => undefined);
    advance(1_000);
    expect(instance.status).toBe('half-open');

    let release: () => void = () => undefined;
    const probe = instance.run(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('ok');
        }),
    );

    // A second call arriving while the probe is out is the flood this exists
    // to prevent, and must be refused.
    await expect(instance.run(succeed)).rejects.toBeInstanceOf(CircuitOpenError);

    release();
    await probe;
    expect(instance.status).toBe('closed');
  });

  it('reopens at once when the probe fails, without counting to the threshold again', async () => {
    const { instance, advance } = breaker(5, 1_000);
    for (let i = 0; i < 5; i += 1) await instance.run(fail).catch(() => undefined);
    advance(1_000);

    await instance.run(fail).catch(() => undefined);
    expect(instance.status).toBe('open');
  });
});
