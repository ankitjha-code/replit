import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRateLimitStore } from './rate-limit.js';

describe('MemoryRateLimitStore', () => {
  let store: MemoryRateLimitStore;

  beforeEach(() => {
    store = new MemoryRateLimitStore();
  });

  it('counts hits within a window', () => {
    expect(store.hit('a', 1_000).count).toBe(1);
    expect(store.hit('a', 1_000).count).toBe(2);
    expect(store.hit('a', 1_000).count).toBe(3);
  });

  it('counts keys independently', () => {
    store.hit('a', 1_000);
    store.hit('a', 1_000);
    expect(store.hit('b', 1_000).count).toBe(1);
  });

  it('reports when the window ends', () => {
    const before = Date.now();
    const { resetAt } = store.hit('a', 5_000);
    expect(resetAt).toBeGreaterThanOrEqual(before + 5_000);
  });

  describe('over time', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('starts a fresh window after the old one expires', () => {
      store.hit('a', 1_000);
      store.hit('a', 1_000);
      vi.advanceTimersByTime(1_001);
      expect(store.hit('a', 1_000).count).toBe(1);
    });

    it('discards expired entries so the map cannot grow without bound', () => {
      // An attacker rotating source addresses would otherwise add an entry per
      // address that is never reclaimed.
      for (let i = 0; i < 500; i += 1) {
        store.hit(`client-${i}`, 1_000);
      }
      vi.advanceTimersByTime(120_000);
      store.hit('trigger-sweep', 1_000);

      expect(store.hit('client-0', 1_000).count).toBe(1);
    });
  });
});
