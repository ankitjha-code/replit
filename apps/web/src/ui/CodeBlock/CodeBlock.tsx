import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { CopyButton } from '../CopyButton/CopyButton.js';
import { cx } from '../internal/cx.js';
import './CodeBlock.css';

export interface CodeBlockProps extends Omit<ComponentPropsWithoutRef<'div'>, 'children'> {
  code: string;
  label: string;
  copy?: boolean;
  wrap?: boolean;
}

export const CodeBlock = forwardRef<HTMLDivElement, CodeBlockProps>(function CodeBlock(
  { code, label, copy = false, wrap = false, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cx('ui-code-block', wrap && 'ui-code-block--wrap', className)}
      {...rest}
    >
      <pre className="ui-code-block__pre" aria-label={label} tabIndex={0}>
        <code>{code}</code>
      </pre>
      {copy ? (
        <CopyButton
          value={code}
          label={`Copy ${label.toLowerCase()}`}
          className="ui-code-block__copy"
        />
      ) : null}
    </div>
  );
});
