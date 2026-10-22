import { useState, type FocusEvent, type ReactNode } from 'react';
import { IconButton } from '../ui/IconButton/IconButton.js';
import { Input } from '../ui/Input/Input.js';
import { Select, type SelectOption } from '../ui/Select/Select.js';
import { Textarea } from '../ui/Textarea/Textarea.js';
import { Eye, EyeSlash } from '../ui/icons.js';
import '../ui/Field/Field.css';

type FieldChangeEvent = { target: { value: string } };

interface FieldProps {
  id: string;
  label: string;
  value?: string;
  onChange?: (event: FieldChangeEvent) => void;
  /** When the control loses focus: a check that should wait until the person moves on. */
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  type?: string;
  autoComplete?: string;
  error?: string | undefined;
  hint?: string;
  autoFocus?: boolean;
  /** Which control to render. 'password' is an input with a Show/Hide toggle. */
  as?: 'input' | 'textarea' | 'select' | 'password';
  inputMode?: 'none' | 'text' | 'decimal' | 'numeric' | 'tel' | 'search' | 'email' | 'url';
  placeholder?: string;
  required?: boolean;
  mono?: boolean;
  /** Adds the Show/Hide toggle to a password input given through `type`. */
  revealable?: boolean;
  /** A small link or button at the right of the label ("Forgot password?"). */
  action?: ReactNode;
  /** For `as: 'select'`. */
  options?: SelectOption[];
  name?: string;
  disabled?: boolean;
  disabledReason?: string;
  maxLength?: number;
  rows?: number;
  /** A custom control. It must carry `id` so the label reaches it. */
  children?: ReactNode;
}

/**
 * A labelled control with its error or hint.
 *
 * The two are mutually exclusive by design: showing a hint underneath an error
 * pushes the thing the user needs to read further from the input that caused
 * it. The onChange event keeps the `{ target: { value } }` shape the auth
 * pages rely on.
 */
export function Field({
  id,
  label,
  value,
  onChange,
  onBlur,
  type = 'text',
  autoComplete,
  error,
  hint,
  autoFocus,
  as = 'input',
  inputMode,
  placeholder,
  required,
  mono,
  revealable,
  action,
  options,
  name,
  disabled,
  disabledReason,
  maxLength,
  rows,
  children,
}: FieldProps): React.JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  const isPassword = as === 'password' || type === 'password';
  const canReveal = isPassword && (as === 'password' || Boolean(revealable));

  const common = {
    id,
    name: name ?? id,
    ...(value !== undefined ? { value } : {}),
    ...(onChange ? { onChange } : {}),
    ...(onBlur ? { onBlur } : {}),
    ...(autoComplete ? { autoComplete } : {}),
    ...(autoFocus ? { autoFocus } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(required ? { required, 'aria-required': true as const } : {}),
    ...(disabled ? { disabled } : {}),
    ...(disabledReason ? { disabledReason } : {}),
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    invalid: Boolean(error),
    ...(mono ? { mono } : {}),
  };

  let control: ReactNode;
  if (children) {
    control = children;
  } else if (as === 'textarea') {
    control = (
      <Textarea {...common} {...(rows ? { rows } : {})} {...(maxLength ? { maxLength } : {})} />
    );
  } else if (as === 'select') {
    control = <Select {...common} {...(options ? { options } : {})} />;
  } else {
    control = (
      <Input
        {...common}
        type={isPassword ? (revealed ? 'text' : 'password') : type}
        {...(inputMode ? { inputMode } : {})}
        {...(maxLength ? { maxLength } : {})}
        {...(canReveal
          ? {
              trailing: (
                <IconButton
                  size="sm"
                  label={revealed ? 'Hide password' : 'Show password'}
                  icon={revealed ? EyeSlash : Eye}
                  aria-pressed={revealed}
                  onClick={() => setRevealed((current) => !current)}
                />
              ),
            }
          : {})}
      />
    );
  }

  return (
    <div className="ui-field field">
      <div className="ui-field__head">
        <label htmlFor={id} className="ui-field__label">
          {label}
        </label>
        {action ? <span className="ui-field__action">{action}</span> : null}
      </div>
      {control}
      {error ? (
        <p className="ui-field__error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="ui-field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
