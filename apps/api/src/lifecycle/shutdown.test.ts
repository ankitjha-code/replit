import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createShutdownHandler, type ShutdownTargets } from './shutdown.js';

const silent = pino({ level: 'silent' });

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function harness(overrides: Partial<ShutdownTargets> = {}) {
  const order: string[] = [];
  const exit = vi.fn<(code: number) => void>();

  const handler = createShutdownHandler({
    closeServer: async () => {
      order.push('server');
    },
    disconnectDatabase: async () => {
      order.push('database');
    },
    log: silent,
    exit,
    ...overrides,
  });

  return { handler, order, exit };
}

describe('createShutdownHandler', () => {
  it('closes the server before the database', async () => {
    const { handler, order } = harness();
    handler('SIGTERM');
    await settle();
    // Reversing this would drop the connection out from under a request that
    // is still finishing.
    expect(order).toEqual(['server', 'database']);
  });

  it('exits zero on a clean shutdown', async () => {
    const { handler, exit } = harness();
    handler('SIGTERM');
    await settle();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('ignores repeated signals', async () => {
    const { handler, order, exit } = harness();
    handler('SIGINT');
    handler('SIGINT');
    handler('SIGTERM');
    await settle();
    expect(order).toEqual(['server', 'database']);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('still closes the database when the server fails to close', async () => {
    const order: string[] = [];
    const { handler, exit } = harness({
      closeServer: () => Promise.reject(new Error('listener stuck')),
      disconnectDatabase: async () => {
        order.push('database');
      },
    });

    handler('SIGTERM');
    await settle();

    expect(order).toEqual(['database']);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits non-zero when the database fails to close', async () => {
    const { handler, exit } = harness({
      disconnectDatabase: () => Promise.reject(new Error('pool stuck')),
    });
    handler('SIGTERM');
    await settle();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('works with no database configured', async () => {
    const { handler, order, exit } = harness({ disconnectDatabase: undefined });
    handler('SIGTERM');
    await settle();
    expect(order).toEqual(['server']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('forces exit when shutdown hangs', async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn<(code: number) => void>();
      const handler = createShutdownHandler({
        closeServer: () => new Promise(() => {}),
        log: silent,
        exit,
        forceExitAfterMs: 5_000,
      });

      handler('SIGTERM');
      expect(exit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(5_000);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the force timer once shutdown completes', async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn<(code: number) => void>();
      const handler = createShutdownHandler({
        closeServer: () => Promise.resolve(),
        log: silent,
        exit,
        forceExitAfterMs: 5_000,
      });

      handler('SIGTERM');
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).toHaveBeenCalledWith(0);

      await vi.advanceTimersByTimeAsync(10_000);
      // Not a second, forced exit.
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
