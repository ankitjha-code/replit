import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { cx } from '../internal/cx.js';
import type { Tone } from '../internal/types.js';
import './StatusDot.css';

export interface StatusDotProps extends ComponentPropsWithoutRef<'span'> {
  tone?: Tone;
  pulse?: boolean;
  label: string;
}

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
