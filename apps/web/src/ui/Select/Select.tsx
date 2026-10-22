import { forwardRef, useId, type ChangeEvent, type ComponentPropsWithoutRef } from 'react';
import { Spinner } from '../Spinner/Spinner.js';
import { CaretUpDown } from '../icons.js';
import { DisabledReason, describedBy } from '../internal/DisabledReason.js';
import { cx } from '../internal/cx.js';
import type { Size } from '../internal/types.js';
import { useAsyncChange } from '../internal/use-async-change.js';
import './Select.css';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<ComponentPropsWithoutRef<'select'>, 'size' | 'value'> {
  size?: Size;
  invalid?: boolean;
  /** Either `options` or `<option>` children. */
  options?: SelectOption[];
  value?: string;
  /**
   * Applies the value at once. Return a promise for a per-row select that
   * saves on change: the previous value comes back if it rejects.
   */
  onValueChange?: (value: string) => void | Promise<void>;
  loading?: boolean;
  disabledReason?: string;
}

/**
 * A native select in a styled wrapper. Native on purpose: tests drive it with
 * selectOptions and every platform's picker stays accessible for free.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    size = 'lg',
    invalid = false,
    options,
    value,
    onValueChange,
    onChange,
    loading = false,
    disabledReason,
    disabled,
    className,
    children,
    'aria-describedby': ariaDescribedBy,
    ...rest
  },
  ref,
) {
  const reasonId = useId();
  const async = useAsyncChange(value, onValueChange);
  const busy = loading || async.pending;

  const handleChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    onChange?.(event);
    if (onValueChange) async.change(event.target.value);
  };

  const field = (
    <span
      className={cx(
        'ui-select-wrap',
        `ui-select-wrap--${size}`,
        invalid && 'ui-select-wrap--invalid',
        (disabled || disabledReason) && 'ui-select-wrap--disabled',
        className,
      )}
    >
      <select
        ref={ref}
        className="ui-select"
        disabled={Boolean(disabled) || Boolean(disabledReason)}
        aria-invalid={invalid || undefined}
        aria-busy={busy || undefined}
        aria-describedby={describedBy(ariaDescribedBy, disabledReason ? reasonId : undefined)}
        onChange={handleChange}
        {...(value !== undefined ? { value: async.value } : {})}
        {...rest}
      >
        {options
          ? options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ))
          : children}
      </select>
      <span className="ui-select__caret" aria-hidden="true">
        {busy ? <Spinner size={12} aria-hidden="true" /> : <CaretUpDown size={16} />}
      </span>
    </span>
  );
  return (
    <DisabledReason id={reasonId} reason={disabledReason} block>
      {field}
    </DisabledReason>
  );
});
