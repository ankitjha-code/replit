import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';

export interface VirtualRowsOptions {
  /** How many rows there are. */
  count: number;
  /** Every row is this tall, in pixels. Uniform heights are what make 20k rows cheap. */
  rowHeight: number;
  /** The element that scrolls. */
  scrollRef: RefObject<HTMLElement | null>;
  /** Rows rendered beyond each edge of the viewport, so fast scrolling does not show gaps. */
  overscan?: number;
}

export interface VirtualRows {
  /** Render rows `start` up to but not including `end`. */
  start: number;
  end: number;
  /** Spacer heights that keep the scrollbar honest. */
  paddingTop: number;
  paddingBottom: number;
  totalHeight: number;
  /** True while the person is within one row of the end, which is when "follow" may scroll. */
  atBottom: boolean;
  scrollToIndex: (index: number) => void;
  scrollToEnd: () => void;
}

/**
 * Renders only the rows that fit in a scrolling element.
 *
 * Reads the element's scroll position and height, and hands back the window
 * of rows to render with the padding that stands in for the rest. Uniform row
 * height is required; a log or a file tree with fixed-height rows is the use.
 */
export function useVirtualRows({
  count,
  rowHeight,
  scrollRef,
  overscan = 8,
}: VirtualRowsOptions): VirtualRows {
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const measure = (): void => {
      setViewport((previous) => {
        const next = { scrollTop: element.scrollTop, height: element.clientHeight };
        return previous.scrollTop === next.scrollTop && previous.height === next.height
          ? previous
          : next;
      });
    };

    measure();
    element.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined;
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [scrollRef]);

  const totalHeight = count * rowHeight;
  // Clamped, because the list can shrink while the element is still scrolled
  // past its new end (a filter, a cleared log); `start` must never pass `count`.
  const first = Math.min(Math.floor(viewport.scrollTop / rowHeight), Math.max(0, count - 1));
  const visible = Math.ceil(viewport.height / rowHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);
  const atBottom = viewport.scrollTop + viewport.height >= totalHeight - rowHeight;

  const scrollToIndex = useCallback(
    (index: number) => {
      const element = scrollRef.current;
      if (!element) return;
      element.scrollTop = Math.max(0, Math.min(index, count - 1)) * rowHeight;
    },
    [scrollRef, count, rowHeight],
  );

  const scrollToEnd = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [scrollRef]);

  return {
    start,
    end,
    paddingTop: start * rowHeight,
    paddingBottom: Math.max(0, (count - end) * rowHeight),
    totalHeight,
    atBottom,
    scrollToIndex,
    scrollToEnd,
  };
}
