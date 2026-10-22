import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cx } from '../internal/cx.js';
import './ListRow.css';

export interface ListRowProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  leading?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Timestamps, sizes, counts: right of the title on wide screens. */
  meta?: ReactNode;
  badge?: ReactNode;
  /** RowActions, at the right end. */
  actions?: ReactNode;
  /** Block content below the row: a build log, a DNS record. */
  expanded?: ReactNode;
  selected?: boolean;
  /**
   * On phones, where the row wraps, put the meta line before the actions
   * rather than after them (facts first, then what you can do about them).
   */
  metaFirst?: boolean;
  /** Render as a div (outside a list). */
  as?: 'li' | 'div';
}

/** One item of a list where the row carries a title line and, optionally, a block below it. */
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
