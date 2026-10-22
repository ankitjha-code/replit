import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { Info, Warning, WifiSlash, XCircle } from '../icons.js';
import { cx } from '../internal/cx.js';
import type { IconLike } from '../internal/types.js';
import { renderIcon } from '../internal/types.js';
import './Banner.css';

export type BannerTone = 'info' | 'warn' | 'danger' | 'offline';

export interface BannerProps extends ComponentPropsWithoutRef<'div'> {
  tone?: BannerTone;
  message: ReactNode;
  action?: ReactNode;
  icon?: IconLike;
}

const ICONS: Record<BannerTone, IconLike> = {
  info: Info,
  warn: Warning,
  danger: XCircle,
  offline: WifiSlash,
};

export const Banner = forwardRef<HTMLDivElement, BannerProps>(function Banner(
  { tone = 'info', message, action, icon, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cx('ui-banner', `ui-banner--${tone}`, className)}
      role={tone === 'danger' ? 'alert' : 'status'}
      {...rest}
    >
      <span className="ui-banner__icon">{renderIcon(icon ?? ICONS[tone])}</span>
      <span className="ui-banner__message">{message}</span>
      {action ? <span className="ui-banner__action">{action}</span> : null}
    </div>
  );
});
