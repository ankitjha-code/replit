import { Fragment, forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Skeleton } from '../Skeleton/Skeleton.js';
import { CaretRight } from '../icons.js';
import { cx } from '../internal/cx.js';
import './Breadcrumb.css';

export interface BreadcrumbItem {
  label?: ReactNode;
  to?: string;
  loading?: boolean;
}

export interface BreadcrumbProps extends Omit<ComponentPropsWithoutRef<'nav'>, 'children'> {
  items: BreadcrumbItem[];
}

export const Breadcrumb = forwardRef<HTMLElement, BreadcrumbProps>(function Breadcrumb(
  { items, className, ...rest },
  ref,
) {
  return (
    <nav ref={ref} aria-label="Breadcrumb" className={cx('ui-breadcrumb', className)} {...rest}>
      <ol className="ui-breadcrumb__list">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          let content: ReactNode;
          if (item.loading) {
            content = <Skeleton width={96} height={14} className="ui-breadcrumb__skeleton" />;
          } else if (item.to && !last) {
            content = (
              <Link to={item.to} className="ui-breadcrumb__link">
                {item.label}
              </Link>
            );
          } else {
            content = (
              <span className="ui-breadcrumb__current" aria-current={last ? 'page' : undefined}>
                {item.label}
              </span>
            );
          }
          return (
            <Fragment key={index}>
              {index > 0 ? (
                <li className="ui-breadcrumb__separator" aria-hidden="true">
                  <CaretRight size={12} />
                </li>
              ) : null}
              <li className="ui-breadcrumb__item" aria-busy={item.loading || undefined}>
                {content}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
});
