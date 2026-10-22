import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { IconButton } from '../IconButton/IconButton.js';
import { Popover } from '../Popover/Popover.js';
import { Question } from '../icons.js';
import { cx } from '../internal/cx.js';
import { renderIcon, type IconLike } from '../internal/types.js';
import './SectionHeader.css';

export interface SectionHeaderProps extends Omit<ComponentPropsWithoutRef<'div'>, 'title'> {
  title: ReactNode;
  icon?: IconLike;
  description?: ReactNode;
  help?: ReactNode;
  action?: ReactNode;
  count?: number;
  id?: string;
}

export const SectionHeader = forwardRef<HTMLDivElement, SectionHeaderProps>(function SectionHeader(
  { title, icon, description, help, action, count, id, className, ...rest },
  ref,
) {
  return (
    <div ref={ref} id={id} className={cx('ui-section-header', className)} {...rest}>
      <div className="ui-section-header__text">
        <h2 className="ui-section-header__title">
          {renderIcon(icon)}
          <span>{title}</span>
          {count !== undefined ? <span className="ui-section-header__count">{count}</span> : null}
          {help ? (
            <Popover
              trigger={<IconButton label="About this section" icon={Question} size="sm" />}
              label="About this section"
            >
              <div className="ui-section-header__help">{help}</div>
            </Popover>
          ) : null}
        </h2>
        {description ? <p className="ui-section-header__description">{description}</p> : null}
      </div>
      {action ? <div className="ui-section-header__action">{action}</div> : null}
    </div>
  );
});
