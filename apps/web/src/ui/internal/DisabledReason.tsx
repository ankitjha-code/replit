import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Tooltip } from '../Tooltip/Tooltip.js';
import { cx } from './cx.js';

interface DisabledReasonProps {
  id: string;
  reason: string | undefined;
  /** Lay the wrapper out as a block (inputs) rather than inline (buttons). */
  block?: boolean;
  /**
   * Render the wrapper even while there is no reason, so the control inside
   * keeps its DOM element (and any focus or test reference to it) when a
   * reason comes and goes. Without it the wrapper appears only with a reason.
   */
  persistent?: boolean;
  children: ReactElement;
}

/**
 * A disabled control cannot take focus or pointer events, so the reason lives
 * on a focusable wrapper: a tooltip for pointer and keyboard users, and the
 * same text in a visually-hidden span the control points at with
 * aria-describedby (the control passes `id` there).
 */
export function DisabledReason({
  id,
  reason,
  block,
  persistent = false,
  children,
}: DisabledReasonProps): ReactElement {
  // Controlled throughout, so the persistent wrapper never switches a Radix
  // root between controlled and uncontrolled as the reason comes and goes.
  const [open, setOpen] = useState(false);
  // A tooltip left open when the reason went must not pop up when one returns.
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

/** For controls that render the reason inline (menus) rather than as a tooltip. */
export function describedBy(...ids: Array<string | undefined>): string | undefined {
  const list = ids.filter(Boolean);
  return list.length ? list.join(' ') : undefined;
}

export type { ReactNode };
