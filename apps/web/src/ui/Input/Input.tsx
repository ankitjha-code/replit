import { forwardRef, useId, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { DisabledReason, describedBy } from '../internal/DisabledReason.js';
import { cx } from '../internal/cx.js';
import type { Size } from '../internal/types.js';
import './Input.css';

export interface InputProps extends Omit<ComponentPropsWithoutRef<'input'>, 'size'> {
  size?: Size;
  invalid?: boolean;
  mono?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  disabledReason?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    size = 'lg',
    invalid = false,
    mono = false,
    leading,
    trailing,
    disabledReason,
    disabled,
    className,
    'aria-describedby': ariaDescribedBy,
    ...rest
  },
  ref,
) {
  const reasonId = useId();
  const field = (
    <span
      className={cx(
        'ui-input-wrap',
        `ui-input-wrap--${size}`,
        invalid && 'ui-input-wrap--invalid',
        mono && 'ui-input-wrap--mono',
        (disabled || disabledReason) && 'ui-input-wrap--disabled',
        rest.readOnly && 'ui-input-wrap--readonly',
        className,
      )}
    >
      {leading ? <span className="ui-input__leading">{leading}</span> : null}
      <input
        ref={ref}
        className="ui-input"
        disabled={Boolean(disabled) || Boolean(disabledReason)}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy(ariaDescribedBy, disabledReason ? reasonId : undefined)}
        {...rest}
      />
      {trailing ? <span className="ui-input__trailing">{trailing}</span> : null}
    </span>
  );
  return (
    <DisabledReason id={reasonId} reason={disabledReason} block>
      {field}
    </DisabledReason>
  );
});
