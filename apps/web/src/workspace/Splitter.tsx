import { useCallback, useRef, type KeyboardEvent, type PointerEvent } from 'react';

interface SplitterProps {
  orientation: 'vertical' | 'horizontal';
  /** Current size of the panel being resized, as a fraction of the container. */
  fraction: number;
  onChange: (fraction: number) => void;
  /** Which side of the splitter the resized panel sits on. */
  side: 'start' | 'end';
  label: string;
  /** The element the fraction is measured against. */
  containerRef: React.RefObject<HTMLElement | null>;
}

/** How far one arrow-key press moves the divider. */
const KEYBOARD_STEP = 0.02;

/**
 * A draggable divider between two panels.
 *
 * Keyboard operable, not only draggable. A pointer-only resize excludes anyone
 * using a keyboard from a control that changes how much of their editor they
 * can see, and the ARIA separator role exists precisely for this.
 */
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
      // A panel on the far side grows as the pointer moves toward the near
      // side, so its fraction is the complement.
      return side === 'start' ? ratio : 1 - ratio;
    },
    [containerRef, orientation, side],
  );

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    dragging.current = true;
    // Capture so the drag survives the pointer leaving the thin divider, which
    // it will do constantly.
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

    // The near panel grows in the direction of the key; the far panel shrinks,
    // so the sign flips.
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
      // The separator's own orientation is perpendicular to the axis it
      // resizes, which is what the ARIA specification means by the attribute.
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
