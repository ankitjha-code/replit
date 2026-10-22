import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  type ChangeEvent,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { Spinner } from '../Spinner/Spinner.js';
import { DisabledReason, describedBy } from '../internal/DisabledReason.js';
import { cx } from '../internal/cx.js';
import { useAsyncChange } from '../internal/use-async-change.js';
import './Checkbox.css';

export interface CheckboxProps extends Omit<
  ComponentPropsWithoutRef<'input'>,
  'type' | 'size' | 'checked'
> {
  label: ReactNode;
  description?: ReactNode;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void | Promise<void>;
  indeterminate?: boolean;
  loading?: boolean;
  disabledReason?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  {
    label,
    description,
    checked,
    onCheckedChange,
    onChange,
    indeterminate = false,
    loading = false,
    disabledReason,
    disabled,
    className,
    id,
    'aria-describedby': ariaDescribedBy,
    ...rest
  },
  forwardedRef,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const descriptionId = `${inputId}-description`;
  const reasonId = useId();
  const ref = useRef<HTMLInputElement>(null);
  useImperativeHandle(forwardedRef, () => ref.current as HTMLInputElement);
  const async = useAsyncChange(checked, onCheckedChange);
  const busy = loading || async.pending;

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange?.(event);
    if (onCheckedChange) async.change(event.target.checked);
  };

  const control = (
    <div
      className={cx(
        'ui-checkbox',
        (disabled || disabledReason) && 'ui-checkbox--disabled',
        className,
      )}
    >
      <span className="ui-checkbox__control">
        {busy ? (
          <Spinner size={12} aria-hidden="true" className="ui-checkbox__spinner" />
        ) : (
          <input
            ref={ref}
            id={inputId}
            type="checkbox"
            className="ui-checkbox__input"
            disabled={Boolean(disabled) || Boolean(disabledReason)}
            aria-describedby={describedBy(
              ariaDescribedBy,
              description ? descriptionId : undefined,
              disabledReason ? reasonId : undefined,
            )}
            onChange={handleChange}
            {...(checked !== undefined ? { checked: async.value ?? false } : {})}
            {...rest}
          />
        )}
      </span>
      <label htmlFor={inputId} className="ui-checkbox__label">
        {label}
      </label>
      {description ? (
        <span id={descriptionId} className="ui-checkbox__description">
          {description}
        </span>
      ) : null}
    </div>
  );
  return (
    <DisabledReason id={reasonId} reason={disabledReason} block>
      {control}
    </DisabledReason>
  );
});
