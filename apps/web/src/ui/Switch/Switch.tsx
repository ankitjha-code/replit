import { forwardRef, useId, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { Switch as Primitive } from 'radix-ui';
import { DisabledReason, describedBy } from '../internal/DisabledReason.js';
import { cx } from '../internal/cx.js';
import type { Size } from '../internal/types.js';
import { useAsyncChange } from '../internal/use-async-change.js';
import './Switch.css';

export interface SwitchProps extends Omit<
  ComponentPropsWithoutRef<typeof Primitive.Root>,
  'onCheckedChange' | 'checked'
> {
  label?: ReactNode;
  description?: ReactNode;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void | Promise<void>;
  loading?: boolean;
  size?: Size;
  disabledReason?: string;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  {
    label,
    description,
    checked,
    onCheckedChange,
    loading = false,
    size = 'md',
    disabledReason,
    disabled,
    className,
    id,
    'aria-describedby': ariaDescribedBy,
    ...rest
  },
  ref,
) {
  const generatedId = useId();
  const switchId = id ?? generatedId;
  const descriptionId = `${switchId}-description`;
  const reasonId = useId();
  const async = useAsyncChange(checked, onCheckedChange);
  const busy = loading || async.pending;

  const control = (
    <div
      className={cx(
        'ui-switch-field',
        `ui-switch-field--${size}`,
        (disabled || disabledReason) && 'ui-switch-field--disabled',
        className,
      )}
    >
      <Primitive.Root
        ref={ref}
        id={switchId}
        className={cx('ui-switch', busy && 'ui-switch--busy')}
        disabled={Boolean(disabled) || Boolean(disabledReason) || busy}
        aria-busy={busy || undefined}
        aria-describedby={describedBy(
          ariaDescribedBy,
          description ? descriptionId : undefined,
          disabledReason ? reasonId : undefined,
        )}
        onCheckedChange={(next) => async.change(next)}
        {...(checked !== undefined ? { checked: async.value ?? false } : {})}
        {...rest}
      >
        <Primitive.Thumb className="ui-switch__thumb" />
      </Primitive.Root>
      {label ? (
        <label htmlFor={switchId} className="ui-switch-field__label">
          {label}
        </label>
      ) : null}
      {description ? (
        <span id={descriptionId} className="ui-switch-field__description">
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
