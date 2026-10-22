import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../Button/Button.js';
import { IconButton } from '../IconButton/IconButton.js';
import { Menu, type MenuItem } from '../Menu/Menu.js';
import { DotsThree } from '../icons.js';
import { cx } from '../internal/cx.js';
import './PageHeader.css';

export interface PageHeaderProps extends Omit<ComponentPropsWithoutRef<'header'>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  breadcrumb?: ReactNode;
  /** A Badge or StatusPill beside the title. */
  status?: ReactNode;
  /** The one primary Button. */
  primaryAction?: ReactNode;
  /** Up to two show as buttons; the rest go in an overflow menu. */
  secondaryActions?: MenuItem[];
}

const VISIBLE_SECONDARY = 2;

/** Where am I, what is this for, what can I do: title, one sentence, one primary action. */
export const PageHeader = forwardRef<HTMLElement, PageHeaderProps>(function PageHeader(
  {
    title,
    description,
    breadcrumb,
    status,
    primaryAction,
    secondaryActions = [],
    className,
    ...rest
  },
  ref,
) {
  const visible = secondaryActions.slice(0, VISIBLE_SECONDARY);
  const overflow = secondaryActions.slice(VISIBLE_SECONDARY);
  return (
    <header ref={ref} className={cx('ui-page-header', className)} {...rest}>
      {breadcrumb ? <div className="ui-page-header__breadcrumb">{breadcrumb}</div> : null}
      <div className="ui-page-header__row">
        <div className="ui-page-header__text">
          <div className="ui-page-header__title-row">
            <h1 className="ui-page-header__title">{title}</h1>
            {status}
          </div>
          {description ? <p className="ui-page-header__description">{description}</p> : null}
        </div>
        {primaryAction || secondaryActions.length ? (
          <div className="ui-page-header__actions">
            {visible.map((action, index) =>
              action.to && !action.disabledReason ? (
                // A destination is a real link: it can open in a new tab and reads as one.
                <Button
                  key={action.id ?? (typeof action.label === 'string' ? action.label : index)}
                  size="lg"
                  asChild
                  {...(action.icon ? { icon: action.icon } : {})}
                >
                  <Link to={action.to} {...(action.onSelect ? { onClick: action.onSelect } : {})}>
                    {action.label}
                  </Link>
                </Button>
              ) : (
                <Button
                  key={action.id ?? (typeof action.label === 'string' ? action.label : index)}
                  size="lg"
                  {...(action.icon ? { icon: action.icon } : {})}
                  {...(action.onSelect ? { onClick: action.onSelect } : {})}
                  {...(action.disabledReason ? { disabledReason: action.disabledReason } : {})}
                >
                  {action.label}
                </Button>
              ),
            )}
            {overflow.length ? (
              <Menu
                trigger={
                  <IconButton label="More actions" icon={DotsThree} size="lg" variant="secondary" />
                }
                items={overflow}
              />
            ) : null}
            {primaryAction}
          </div>
        ) : null}
      </div>
    </header>
  );
});
