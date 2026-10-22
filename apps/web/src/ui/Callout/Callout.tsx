import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { IconButton } from '../IconButton/IconButton.js';
import { CheckCircle, Info, Warning, X, XCircle } from '../icons.js';
import { cx } from '../internal/cx.js';
import './Callout.css';

export type CalloutTone = 'info' | 'warn' | 'danger' | 'ok';

export interface CalloutProps extends Omit<ComponentPropsWithoutRef<'div'>, 'title'> {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
}

const ICONS: Record<CalloutTone, typeof Info> = {
  info: Info,
  warn: Warning,
  danger: XCircle,
  ok: CheckCircle,
};

export const Callout = forwardRef<HTMLDivElement, CalloutProps>(function Callout(
  { tone = 'info', title, children, action, onDismiss, className, ...rest },
  ref,
) {
  const Icon = ICONS[tone];
  return (
    <div
      ref={ref}
      className={cx('ui-callout', `ui-callout--${tone}`, className)}
      role={tone === 'danger' ? 'alert' : 'status'}
      {...rest}
    >
      <Icon size={16} className="ui-callout__icon" aria-hidden="true" />
      <div className="ui-callout__body">
        {title ? <p className="ui-callout__title">{title}</p> : null}
        {children ? <div className="ui-callout__text">{children}</div> : null}
        {action ? <div className="ui-callout__action">{action}</div> : null}
      </div>
      {onDismiss ? (
        <IconButton
          label="Dismiss"
          icon={X}
          size="sm"
          className="ui-callout__dismiss"
          onClick={onDismiss}
        />
      ) : null}
    </div>
  );
});
