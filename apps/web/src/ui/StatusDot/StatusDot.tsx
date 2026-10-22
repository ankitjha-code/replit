import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { cx } from '../internal/cx.js';
import type { Tone } from '../internal/types.js';
import './StatusDot.css';

export interface StatusDotProps extends ComponentPropsWithoutRef<'span'> {
  tone?: Tone;
  /** For a state in transition (Starting). Still under reduced motion. */
  pulse?: boolean;
  /** What the colour means, for assistive technology. */
  label: string;
}

/** An 8px dot whose colour is repeated in text, so it never carries meaning alone. */
export const StatusDot = forwardRef<HTMLSpanElement, StatusDotProps>(function StatusDot(
  { tone = 'neutral', pulse = false, label, className, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cx(
        'ui-status-dot',
        `ui-status-dot--${tone}`,
        pulse && 'ui-status-dot--pulse',
        className,
      )}
      role="img"
      aria-label={label}
      {...rest}
    />
  );
});
