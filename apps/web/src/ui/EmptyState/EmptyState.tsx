import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import type { Icon } from '../icons.js';
import { cx } from '../internal/cx.js';
import './EmptyState.css';

export interface EmptyStateProps extends Omit<ComponentPropsWithoutRef<'div'>, 'title'> {
  icon: Icon;
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  secondary?: ReactNode;
  size?: 'panel' | 'page';
}

export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { icon: IconComponent, title, body, action, secondary, size = 'panel', className, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={cx('ui-empty-state', `ui-empty-state--${size}`, className)} {...rest}>
      <IconComponent size={32} weight="light" className="ui-empty-state__icon" aria-hidden="true" />
      <p className="ui-empty-state__title">{title}</p>
      {body ? <p className="ui-empty-state__body">{body}</p> : null}
      {action || secondary ? (
        <div className="ui-empty-state__actions">
          {action}
          {secondary}
        </div>
      ) : null}
    </div>
  );
});
