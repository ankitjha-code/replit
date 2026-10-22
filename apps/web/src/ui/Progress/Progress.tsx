import { forwardRef } from 'react';
import { Progress as Primitive } from 'radix-ui';
import { cx } from '../internal/cx.js';
import './Progress.css';

export interface ProgressProps {
  /** 0..max. Omit for an indeterminate bar. */
  value?: number;
  max?: number;
  /** What is progressing ("Pulling image"). */
  label: string;
  indeterminate?: boolean;
  className?: string;
}

/** A 2px bar. Determinate when the work reports a fraction; a moving bar under a header otherwise. */
export const Progress = forwardRef<HTMLDivElement, ProgressProps>(function Progress(
  { value, max = 100, label, indeterminate = false, className },
  ref,
) {
  const unknown = indeterminate || value === undefined;
  const fraction = unknown ? 0 : Math.min(1, Math.max(0, value / max));
  return (
    <Primitive.Root
      ref={ref}
      className={cx('ui-progress', unknown && 'ui-progress--indeterminate', className)}
      value={unknown ? null : value}
      max={max}
      aria-label={label}
    >
      <Primitive.Indicator
        className="ui-progress__bar"
        style={unknown ? undefined : { transform: `translateX(${(fraction - 1) * 100}%)` }}
      />
    </Primitive.Root>
  );
});
