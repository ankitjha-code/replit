import { forwardRef, useEffect, useRef, useState } from 'react';
import { copyText } from '../../lib/clipboard.js';
import { Button, type ButtonProps } from '../Button/Button.js';
import { IconButton } from '../IconButton/IconButton.js';
import { toast } from '../Toast/toast-store.js';
import { Check, Copy } from '../icons.js';
import { cx } from '../internal/cx.js';
import './CopyButton.css';

export interface CopyButtonProps extends Omit<
  ButtonProps,
  'children' | 'onClick' | 'icon' | 'value'
> {
  /** What goes on the clipboard. */
  value: string;
  /** The accessible name and tooltip: "Copy URL", "Copy connection string". */
  label?: string;
  /** Show the label beside the icon rather than icon-only. */
  withText?: boolean;
}

const COPIED_MS = 1500;

/** Every value a user will paste elsewhere gets one of these. */
export const CopyButton = forwardRef<HTMLButtonElement, CopyButtonProps>(function CopyButton(
  { value, label = 'Copy', withText = false, size = 'sm', variant = 'ghost', className, ...rest },
  ref,
) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async (): Promise<void> => {
    const ok = await copyText(value);
    if (!ok) {
      toast({
        tone: 'danger',
        title: 'Could not copy',
        description: 'Select the value and copy it by hand.',
      });
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  const status = (
    <span role="status" className="visually-hidden">
      {copied ? 'Copied' : ''}
    </span>
  );

  if (withText) {
    return (
      <>
        <Button
          ref={ref}
          size={size}
          variant={variant}
          icon={copied ? Check : Copy}
          className={cx('ui-copy-button', copied && 'ui-copy-button--copied', className)}
          onClick={() => void copy()}
          {...rest}
        >
          {copied ? 'Copied' : label}
        </Button>
        {status}
      </>
    );
  }
  return (
    <>
      <IconButton
        ref={ref}
        size={size}
        variant={variant}
        label={copied ? 'Copied' : label}
        icon={copied ? Check : Copy}
        className={cx('ui-copy-button', copied && 'ui-copy-button--copied', className)}
        onClick={() => void copy()}
        {...rest}
      />
      {status}
    </>
  );
});
