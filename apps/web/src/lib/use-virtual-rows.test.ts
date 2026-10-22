import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useVirtualRows } from './use-virtual-rows.js';

const makeScroller = (height: number) => {
  const element = document.createElement('div');
  Object.defineProperty(element, 'clientHeight', { value: height, configurable: true });
  Object.defineProperty(element, 'scrollHeight', { get: () => 20_000 * 20, configurable: true });
  document.body.appendChild(element);
  return element;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useVirtualRows', () => {
  it('renders only the rows in view plus overscan', () => {
    const element = makeScroller(200);
    const { result } = renderHook(() =>
      useVirtualRows({
        count: 20_000,
        rowHeight: 20,
        scrollRef: { current: element },
        overscan: 2,
      }),
    );
    expect(result.current.start).toBe(0);
    expect(result.current.end).toBe(12);
    expect(result.current.paddingTop).toBe(0);
    expect(result.current.paddingBottom).toBe((20_000 - 12) * 20);
    expect(result.current.totalHeight).toBe(400_000);
    expect(result.current.atBottom).toBe(false);
  });

  it('moves the window with the scroll position', () => {
    const element = makeScroller(200);
    const { result } = renderHook(() =>
      useVirtualRows({
        count: 20_000,
        rowHeight: 20,
        scrollRef: { current: element },
        overscan: 2,
      }),
    );
    act(() => {
      element.scrollTop = 10_000;
      element.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.start).toBe(498);
    expect(result.current.end).toBe(512);
    expect(result.current.paddingTop).toBe(498 * 20);
  });

  it('knows when the person is at the bottom and can jump there', () => {
    const element = makeScroller(200);
    const { result } = renderHook(() =>
      useVirtualRows({ count: 100, rowHeight: 20, scrollRef: { current: element } }),
    );
    act(() => result.current.scrollToEnd());
    act(() => element.dispatchEvent(new Event('scroll')));
    expect(result.current.atBottom).toBe(true);
    expect(result.current.end).toBe(100);

    act(() => result.current.scrollToIndex(5));
    expect(element.scrollTop).toBe(100);
  });

  it('clamps to the row count', () => {
    const element = makeScroller(200);
    const { result } = renderHook(() =>
      useVirtualRows({ count: 3, rowHeight: 20, scrollRef: { current: element } }),
    );
    expect(result.current.end).toBe(3);
    expect(result.current.paddingBottom).toBe(0);
  });

  it('stays inside the list when it shrinks under a deep scroll offset', () => {
    const element = makeScroller(200);
    const { result, rerender } = renderHook(
      ({ count }) =>
        useVirtualRows({ count, rowHeight: 20, scrollRef: { current: element }, overscan: 2 }),
      { initialProps: { count: 20_000 } },
    );
    act(() => {
      element.scrollTop = 100_000;
      element.dispatchEvent(new Event('scroll'));
    });

    rerender({ count: 10 });
    expect(result.current.start).toBeLessThanOrEqual(result.current.end);
    expect(result.current.end).toBe(10);
    expect(result.current.start).toBe(7);
    expect(result.current.paddingTop + result.current.paddingBottom).toBeLessThanOrEqual(
      result.current.totalHeight,
    );

    rerender({ count: 0 });
    expect(result.current.start).toBe(0);
    expect(result.current.end).toBe(0);
    expect(result.current.paddingTop).toBe(0);
  });
});
