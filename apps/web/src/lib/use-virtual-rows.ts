import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';

export interface VirtualRowsOptions {
  count: number;
  rowHeight: number;
  scrollRef: RefObject<HTMLElement | null>;
  overscan?: number;
}

export interface VirtualRows {
  start: number;
  end: number;
  paddingTop: number;
  paddingBottom: number;
  totalHeight: number;
  atBottom: boolean;
  scrollToIndex: (index: number) => void;
  scrollToEnd: () => void;
}

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
