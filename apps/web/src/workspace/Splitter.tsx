import { useCallback, useRef, type KeyboardEvent, type PointerEvent } from 'react';

interface SplitterProps {
  orientation: 'vertical' | 'horizontal';
  fraction: number;
  onChange: (fraction: number) => void;
  side: 'start' | 'end';
  label: string;
  containerRef: React.RefObject<HTMLElement | null>;
}

const KEYBOARD_STEP = 0.02;

export function Splitter({
  orientation,
  fraction,
  onChange,
  side,
  label,
  containerRef,
}: SplitterProps): React.JSX.Element {
  const dragging = useRef(false);

  const fractionFromPointer = useCallback(
    (event: PointerEvent<HTMLDivElement>): number | undefined => {
      const container = containerRef.current;
      if (!container) return undefined;

      const rect = container.getBoundingClientRect();
      const size = orientation === 'vertical' ? rect.width : rect.height;
      if (size === 0) return undefined;

      const offset =
        orientation === 'vertical' ? event.clientX - rect.left : event.clientY - rect.top;

      const ratio = offset / size;
      return side === 'start' ? ratio : 1 - ratio;
    },
    [containerRef, orientation, side],
  );

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    const next = fractionFromPointer(event);
    if (next !== undefined) onChange(next);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    dragging.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const grow = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    const shrink = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';

    const direction = side === 'start' ? 1 : -1;

    if (event.key === grow) {
      event.preventDefault();
      onChange(fraction + KEYBOARD_STEP * direction);
    } else if (event.key === shrink) {
      event.preventDefault();
      onChange(fraction - KEYBOARD_STEP * direction);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation={orientation === 'vertical' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={Math.round(fraction * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      className={`splitter splitter--${orientation}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}
