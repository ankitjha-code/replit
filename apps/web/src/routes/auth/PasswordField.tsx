import { useState, type ReactElement, type ReactNode } from 'react';
import { Field } from '../../components/Field.js';
import { IconButton, Input } from '../../ui/index.js';
import { Eye, EyeSlash } from '../../ui/icons.js';

export interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  error?: string | undefined;
  hint?: string;
  autoFocus?: boolean;
  action?: ReactNode;
}

export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  error,
  hint,
  autoFocus,
  action,
}: PasswordFieldProps): ReactElement {
  const [revealed, setRevealed] = useState(false);
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <Field
      id={id}
      label={label}
      error={error}
      {...(hint ? { hint } : {})}
      {...(action ? { action } : {})}
    >
      <Input
        id={id}
        name={id}
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        invalid={Boolean(error)}
        {...(autoFocus ? { autoFocus } : {})}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        trailing={
          <IconButton
            size="sm"
            label={revealed ? 'Hide characters' : 'Show characters'}
            icon={revealed ? EyeSlash : Eye}
            aria-pressed={revealed}
            onClick={() => setRevealed((current) => !current)}
          />
        }
      />
    </Field>
  );
}
