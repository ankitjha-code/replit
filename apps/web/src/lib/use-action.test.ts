import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAction } from './use-action.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('useAction', () => {
  it('is busy while the call is in flight and hands back the value', async () => {
    const call = deferred<string>();
    const { result } = renderHook(() =>
      useAction((id: string) => call.promise.then((v) => v + id)),
    );
    expect(result.current.busy).toBe(false);

    let outcome: Promise<unknown> | undefined;
    act(() => {
      outcome = result.current.run('!');
    });
    expect(result.current.busy).toBe(true);

    await act(async () => {
      call.resolve('done');
      await outcome;
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeUndefined();
    await expect(outcome).resolves.toEqual({ ok: true, value: 'done!' });
  });

  it('stores the error, returns it, and can be reset', async () => {
    const { result } = renderHook(() => useAction(() => Promise.reject(new Error('Nope'))));
    let outcome: { ok: boolean } | undefined;
    await act(async () => {
      outcome = await result.current.run();
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: expect.objectContaining({ message: 'Nope' }),
    });
    expect(result.current.error?.message).toBe('Nope');
    expect(result.current.busy).toBe(false);

    act(() => result.current.reset());
    expect(result.current.error).toBeUndefined();
  });

  it('ignores a second press while busy', async () => {
    const call = deferred<void>();
    const fn = vi.fn(() => call.promise);
    const { result } = renderHook(() => useAction(fn));
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    act(() => {
      first = result.current.run();
      second = result.current.run();
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    await act(async () => {
      call.resolve();
      await first;
    });
    expect(result.current.busy).toBe(false);
  });
});
