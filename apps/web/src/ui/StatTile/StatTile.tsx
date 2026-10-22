import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../Button/Button.js';
import { Callout } from '../Callout/Callout.js';
import { Skeleton } from '../Skeleton/Skeleton.js';
import { ArrowSquareOut } from '../icons.js';
import { cx } from '../internal/cx.js';
import type { Tone } from '../internal/types.js';
import './StatTile.css';

export interface StatTileProps extends Omit<ComponentPropsWithoutRef<'div'>, 'children'> {
  label: string;
  value?: ReactNode;
  /** A short line under the value ("of 10 allowed"). */
  detail?: ReactNode;
  tone?: Tone;
  /** Makes the tile a link. */
  to?: string;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
}

/** "Accounts 12", never "Accounts: 12" in running text. */
export const StatTile = forwardRef<HTMLDivElement, StatTileProps>(function StatTile(
  {
    label,
    value,
    detail,
    tone = 'neutral',
    to,
    loading = false,
    error,
    onRetry,
    className,
    ...rest
  },
  ref,
) {
  const body = loading ? (
    <>
      <Skeleton width={64} height={28} shape="block" className="ui-stat-tile__skeleton" />
      {detail ? <Skeleton width={96} /> : null}
    </>
  ) : error ? (
    <Callout
      tone="danger"
      title={error}
      action={
        onRetry ? (
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    />
  ) : (
    <>
      <span className={cx('ui-stat-tile__value', `ui-stat-tile__value--${tone}`)}>{value}</span>
      {detail ? <span className="ui-stat-tile__detail">{detail}</span> : null}
    </>
  );

  const content = (
    <>
      <span className="ui-stat-tile__label">
        {label}
        {to ? (
          <ArrowSquareOut size={12} className="ui-stat-tile__arrow" aria-hidden="true" />
        ) : null}
      </span>
      {body}
    </>
  );

  if (to) {
    return (
      <div
        ref={ref}
        className={cx('ui-stat-tile', 'ui-stat-tile--link', className)}
        aria-busy={loading || undefined}
        {...rest}
      >
        <Link to={to} className="ui-stat-tile__link">
          {content}
        </Link>
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className={cx('ui-stat-tile', className)}
      aria-busy={loading || undefined}
      {...rest}
    >
      {content}
    </div>
  );
});
