import { forwardRef, useEffect, useState, type ComponentPropsWithoutRef } from 'react';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { Tooltip } from '../Tooltip/Tooltip.js';
import { cx } from '../internal/cx.js';
import './RelativeTime.css';

export interface RelativeTimeProps extends Omit<ComponentPropsWithoutRef<'time'>, 'dateTime'> {
  /** An ISO string, epoch milliseconds or a Date. */
  value: string | number | Date;
  /** Words before the time ("Updated"). */
  prefix?: string;
}

const REFRESH_MS = 30_000;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), REFRESH_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * "3 min ago" in the row, the absolute local time and zone in the tooltip and
 * in the title, so two clocks on one page can be told apart.
 */
export const RelativeTime = forwardRef<HTMLTimeElement, RelativeTimeProps>(function RelativeTime(
  { value, prefix, className, ...rest },
  ref,
) {
  const now = useNow();
  const date = value instanceof Date ? value : new Date(value);
  const valid = !Number.isNaN(date.getTime());
  const absolute = formatDateTime(date);
  const words = relativeTime(date, now);
  return (
    <Tooltip content={absolute}>
      <time
        ref={ref}
        className={cx('ui-relative-time', className)}
        dateTime={valid ? date.toISOString() : undefined}
        title={absolute}
        {...rest}
      >
        {prefix ? `${prefix} ` : ''}
        {words}
      </time>
    </Tooltip>
  );
});
