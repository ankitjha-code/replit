import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { CircleNotch } from '../icons.js';
import { cx } from '../internal/cx.js';
import './Spinner.css';

export interface SpinnerProps extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
  size?: 12 | 16 | 20;
  label?: string;
  labelVisible?: boolean;
}

export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(
  { size = 16, label = 'Loading', labelVisible = false, className, ...rest },
  ref,
) {
  const decorative = rest['aria-hidden'] === true || rest['aria-hidden'] === 'true';
  return (
    <span
      ref={ref}
      className={cx('ui-spinner', labelVisible && 'ui-spinner--labelled', className)}
      role={decorative ? undefined : 'status'}
      {...rest}
    >
      <CircleNotch size={size} className="ui-spinner__glyph" aria-hidden="true" />
      {decorative ? null : (
        <span className={cx('ui-spinner__label', !labelVisible && 'ui-spinner__label--hidden')}>
          {label}
        </span>
      )}
    </span>
  );
});
