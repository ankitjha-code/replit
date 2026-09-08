interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (event: { target: { value: string } }) => void;
  type?: string;
  autoComplete?: string;
  error?: string | undefined;
  hint?: string;
  autoFocus?: boolean;
}

/**
 * A labelled input with its error or hint.
 *
 * The two are mutually exclusive by design: showing a hint underneath an error
 * pushes the thing the user needs to read further from the input that caused
 * it.
 */
export function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  error,
  hint,
  autoFocus,
}: FieldProps): React.JSX.Element {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={error ? 'input input--error' : 'input'}
      />
      {error ? (
        <p className="field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
