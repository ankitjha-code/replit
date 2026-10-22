import { forwardRef, type ElementType, type HTMLAttributes } from 'react';
import { cx } from '../internal/cx.js';
import './Card.css';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  padding?: 'none' | 'sm' | 'md' | 'lg';
  interactive?: boolean;
  tone?: 'default' | 'danger';
  as?: 'div' | 'a' | 'section' | 'article' | 'li';
  href?: string;
}

export const Card = forwardRef<HTMLElement, CardProps>(function Card(
  { padding = 'md', interactive = false, tone = 'default', as = 'div', className, ...rest },
  ref,
) {
  const Component: ElementType = as;
  return (
    <Component
      ref={ref as never}
      className={cx(
        'ui-card',
        `ui-card--pad-${padding}`,
        `ui-card--${tone}`,
        interactive && 'ui-card--interactive',
        className,
      )}
      {...rest}
    />
  );
});
