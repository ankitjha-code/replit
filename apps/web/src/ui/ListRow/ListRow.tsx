import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cx } from '../internal/cx.js';
import './ListRow.css';

export interface ListRowProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  leading?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  expanded?: ReactNode;
  selected?: boolean;
  metaFirst?: boolean;
  as?: 'li' | 'div';
}

export const ListRow = forwardRef<HTMLLIElement, ListRowProps>(function ListRow(
  {
    leading,
    title,
    description,
    meta,
    badge,
    actions,
    expanded,
    selected = false,
    metaFirst = false,
    as = 'li',
    className,
    ...rest
  },
  ref,
) {
  const content = (
    <>
      <div className="ui-list-row__main">
        {leading ? <span className="ui-list-row__leading">{leading}</span> : null}
        <div className="ui-list-row__text">
          <div className="ui-list-row__title-row">
            <span className="ui-list-row__title">{title}</span>
            {badge}
          </div>
          {description ? <div className="ui-list-row__description">{description}</div> : null}
        </div>
        {meta ? <span className="ui-list-row__meta">{meta}</span> : null}
        {actions ? <span className="ui-list-row__actions">{actions}</span> : null}
      </div>
      {expanded ? <div className="ui-list-row__expanded">{expanded}</div> : null}
    </>
  );
  const props = {
    className: cx(
      'ui-list-row',
      selected && 'ui-list-row--selected',
      metaFirst && 'ui-list-row--meta-first',
      className,
    ),
    'aria-selected': selected || undefined,
    ...rest,
  };
  if (as === 'div') {
    return (
      <div ref={ref as never} {...props}>
        {content}
      </div>
    );
  }
  return (
    <li ref={ref} {...props}>
      {content}
    </li>
  );
});
