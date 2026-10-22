import { forwardRef, useState, type ComponentPropsWithoutRef } from 'react';
import { CopyButton } from '../CopyButton/CopyButton.js';
import { IconButton } from '../IconButton/IconButton.js';
import { Eye, EyeSlash } from '../icons.js';
import { cx } from '../internal/cx.js';
import './SecretValue.css';

export interface SecretValueProps extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
  value: string;
  masked?: boolean;
  revealable?: boolean;
  copy?: boolean;
  name?: string;
}

export const SecretValue = forwardRef<HTMLSpanElement, SecretValueProps>(function SecretValue(
  { value, masked = true, revealable = true, copy = false, name = 'value', className, ...rest },
  ref,
) {
  const [hidden, setHidden] = useState(masked);
  return (
    <span ref={ref} className={cx('ui-secret', className)} {...rest}>
      {hidden ? (
        <span className="ui-secret__mask" aria-label="Value is hidden" role="img" />
      ) : (
        <code className="ui-secret__text">{value}</code>
      )}
      {revealable ? (
        <IconButton
          size="sm"
          label={hidden ? `Show ${name}` : `Hide ${name}`}
          icon={hidden ? Eye : EyeSlash}
          aria-pressed={!hidden}
          onClick={() => setHidden((current) => !current)}
        />
      ) : null}
      {copy ? <CopyButton value={value} label={`Copy ${name}`} /> : null}
    </span>
  );
});
