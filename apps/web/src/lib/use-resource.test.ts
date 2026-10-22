import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useResource } from './use-resource.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('useResource', () => {
  it('goes loading then ready with the data', async () => {
    const { result } = renderHook(() => useResource(() => Promise.resolve({ n: 1 }), []));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.data).toEqual({ n: 1 });
  });

  it('reports an error and keeps the previous data on a failed reload', async () => {
    let fail = false;
    const { result } = renderHook(() =>
      useResource(() => (fail ? Promise.reject(new Error('Down')) : Promise.resolve('v1')), []),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    fail = true;
    act(() => result.current.reload());
    expect(result.current.status).toBe('refreshing');
    expect(result.current.data).toBe('v1');
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.message).toBe('Down');
    expect(result.current.data).toBe('v1');
  });

  it('aborts the signal on unmount and drops the late result', async () => {
    let signal: AbortSignal | undefined;
    let resolve!: (value: string) => void;
    const { result, unmount } = renderHook(() =>
      useResource((s) => {
        signal = s;
        return new Promise<string>((res) => {
          resolve = res;
        });
      }, []),
    );
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
    resolve('late');
    await Promise.resolve();
    expect(result.current.status).toBe('loading');
  });

  it('reloads when the deps change and can drop the old data', async () => {
    const load = vi.fn((id: string) => Promise.resolve(`data for ${id}`));
    const { result, rerender } = renderHook(
      ({ id }) => useResource(() => load(id), [id], { keepPrevious: false }),
      { initialProps: { id: 'a' } },
    );
    await waitFor(() => expect(result.current.data).toBe('data for a'));
    rerender({ id: 'b' });
    expect(result.current.status).toBe('loading');
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data).toBe('data for b'));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('polls as a function of the data and stops when it returns null', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const load = vi.fn(() => {
      calls += 1;
      return Promise.resolve({ status: calls < 3 ? 'CREATING' : 'RUNNING' });
    });
    const { result } = renderHook(() =>
      useResource(load, [], { poll: (data) => (data.status === 'CREATING' ? 3_000 : null) }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.data).toEqual({ status: 'CREATING' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(load).toHaveBeenCalledTimes(2);
    // A scheduled poll stays quiet: no spinner every three seconds.
    expect(result.current.status).toBe('ready');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(result.current.data).toEqual({ status: 'RUNNING' });
    expect(load).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('clears a pending poll on unmount', async () => {
    vi.useFakeTimers();
    const load = vi.fn(() => Promise.resolve(1));
    const { unmount } = renderHook(() => useResource(load, [], { poll: 1_000 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
