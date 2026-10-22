import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Tooltip } from '../Tooltip/Tooltip.js';
import { cx } from './cx.js';

interface DisabledReasonProps {
  id: string;
  reason: string | undefined;
  block?: boolean;
  persistent?: boolean;
  children: ReactElement;
}

export function DisabledReason({
  id,
  reason,
  block,
  persistent = false,
  children,
}: DisabledReasonProps): ReactElement {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!reason) setOpen(false);
  }, [reason]);
  if (!reason && !persistent) return children;
  return (
    <Tooltip content={reason ?? ''} open={reason ? open : false} onOpenChange={setOpen}>
      <span
        className={cx('ui-disabled', block && 'ui-disabled--block', !reason && 'ui-disabled--idle')}
        tabIndex={reason ? 0 : undefined}
        aria-describedby={reason ? id : undefined}
      >
        {children}
        {reason ? (
          <span id={id} className="visually-hidden">
            {reason}
          </span>
        ) : null}
      </span>
    </Tooltip>
  );
}

export function describedBy(...ids: Array<string | undefined>): string | undefined {
  const list = ids.filter(Boolean);
  return list.length ? list.join(' ') : undefined;
}

export type { ReactNode };
