import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { cx } from '../internal/cx.js';
import { renderIcon, type IconLike, type Tone } from '../internal/types.js';
import './Badge.css';

export interface BadgeProps extends ComponentPropsWithoutRef<'span'> {
  tone?: Tone;
  icon?: IconLike;
  /** A live indicator: only for a state that is happening right now. */
  dot?: boolean;
  children: ReactNode;
}

/** Text plus colour, never colour alone. Semantic tones carry meaning; `neutral` is for counts and kinds. */
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { tone = 'neutral', icon, dot = false, children, className, ...rest },
  ref,
) {
  return (
    <span ref={ref} className={cx('ui-badge', `ui-badge--${tone}`, className)} {...rest}>
      {dot ? <span className="ui-badge__dot" aria-hidden="true" /> : renderIcon(icon, 12)}
      {children}
    </span>
  );
});

export type StatusPillProps = BadgeProps;

/** A Badge in pill form for a state (Running, Stopped, Failed). */
export const StatusPill = forwardRef<HTMLSpanElement, StatusPillProps>(function StatusPill(
  { className, ...rest },
  ref,
) {
  return <Badge ref={ref} className={cx('ui-badge--pill', className)} {...rest} />;
});
