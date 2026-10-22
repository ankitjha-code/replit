import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuildLog, saveWhileRunning } from './build-log.js';

describe('saveWhileRunning', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves once per interval however many chunks arrived, and not at all when idle', async () => {
    const log = new BuildLog(1024);
    const saved: string[] = [];
    const live = saveWhileRunning(
      log,
      () => {
        saved.push(log.text());
        return Promise.resolve();
      },
      2_000,
    );

    await vi.advanceTimersByTimeAsync(2_000);
    expect(saved).toEqual([]);

    for (let line = 0; line < 50; line += 1) log.write(`line ${String(line)}\n`);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toContain('line 49');

    await vi.advanceTimersByTimeAsync(6_000);
    expect(saved).toHaveLength(1);

    await live.stop();
    log.write('after\n');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(saved).toHaveLength(1);
  });

  it('notices new output even when trimming kept the size the same', async () => {
    const log = new BuildLog(4);
    const saved: string[] = [];
    const live = saveWhileRunning(
      log,
      () => {
        saved.push(log.text());
        return Promise.resolve();
      },
      1_000,
    );

    log.write('aaaa');
    await vi.advanceTimersByTimeAsync(1_000);
    log.write('bbbb');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(saved).toEqual(['aaaa', 'bbbb']);
    await live.stop();
  });

  it('does not start a save while one is still running, and stop waits for it', async () => {
    const log = new BuildLog(1024);
    let calls = 0;
    let finish!: () => void;
    const live = saveWhileRunning(
      log,
      () => {
        calls += 1;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      1_000,
    );

    log.write('one\n');
    await vi.advanceTimersByTimeAsync(1_000);
    log.write('two\n');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toBe(1);

    let stopped = false;
    const stopping = live.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    finish();
    await stopping;
    expect(stopped).toBe(true);
  });
});
