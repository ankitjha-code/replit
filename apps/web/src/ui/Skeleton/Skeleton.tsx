import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { cx } from '../internal/cx.js';
import './Skeleton.css';

export interface SkeletonProps extends ComponentPropsWithoutRef<'div'> {
  shape?: 'text' | 'row' | 'card' | 'block' | 'circle';
  /** For `text`: how many lines. The last line is shorter, like real text. */
  lines?: number;
  width?: number | string;
  height?: number | string;
}

/**
 * A placeholder in the shape of the content that is coming. It is hidden
 * from assistive technology; the region that contains it says aria-busy.
 */
export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(function Skeleton(
  { shape = 'text', lines = 1, width, height, className, style, ...rest },
  ref,
) {
  const sizing = {
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
  if (shape === 'text' && lines > 1) {
    return (
      <div
        ref={ref}
        className={cx('ui-skeleton-lines', className)}
        aria-hidden="true"
        style={{ ...sizing, ...style }}
        {...rest}
      >
        {Array.from({ length: lines }, (_, index) => (
          <span
            key={index}
            className={cx(
              'ui-skeleton',
              'ui-skeleton--text',
              index === lines - 1 && 'ui-skeleton--short',
            )}
          />
        ))}
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className={cx('ui-skeleton', `ui-skeleton--${shape}`, className)}
      aria-hidden="true"
      style={{ ...sizing, ...style }}
      {...rest}
    />
  );
});
