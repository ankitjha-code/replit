import { forwardRef, useId, type ComponentPropsWithoutRef } from 'react';
import { DisabledReason, describedBy } from '../internal/DisabledReason.js';
import { cx } from '../internal/cx.js';
import type { Size } from '../internal/types.js';
import './Textarea.css';

export interface TextareaProps extends ComponentPropsWithoutRef<'textarea'> {
  size?: Size;
  invalid?: boolean;
  mono?: boolean;
  autoGrow?: boolean;
  disabledReason?: string;
}

const MAX_ROWS = 6;

function rowsFor(value: unknown, min: number): number {
  const lines = typeof value === 'string' ? value.split('\n').length : 1;
  return Math.min(MAX_ROWS, Math.max(min, lines));
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    size = 'lg',
    invalid = false,
    mono = false,
    autoGrow = false,
    disabledReason,
    disabled,
    className,
    rows,
    'aria-describedby': ariaDescribedBy,
    ...rest
  },
  ref,
) {
  const reasonId = useId();
  const field = (
    <textarea
      ref={ref}
      className={cx(
        'ui-textarea',
        `ui-textarea--${size}`,
        invalid && 'ui-textarea--invalid',
        mono && 'ui-textarea--mono',
        className,
      )}
      rows={autoGrow ? rowsFor(rest.value ?? rest.defaultValue, rows ?? 1) : (rows ?? 3)}
      disabled={Boolean(disabled) || Boolean(disabledReason)}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy(ariaDescribedBy, disabledReason ? reasonId : undefined)}
      {...rest}
    />
  );
  return (
    <DisabledReason id={reasonId} reason={disabledReason} block>
      {field}
    </DisabledReason>
  );
});
