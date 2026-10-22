import { forwardRef } from 'react';
import { Button, type ButtonProps } from '../Button/Button.js';
import { Tooltip, type TooltipSide } from '../Tooltip/Tooltip.js';
import { cx } from '../internal/cx.js';
import type { IconLike } from '../internal/types.js';
import './IconButton.css';

export interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'iconEnd' | 'children'> {
  label: string;
  icon: IconLike;
  shortcut?: string[];
  tooltipSide?: TooltipSide;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, shortcut, tooltipSide, variant = 'ghost', className, disabledReason, ...rest },
  ref,
) {
  const button = (
    <Button
      ref={ref}
      variant={variant}
      icon={icon}
      aria-label={label}
      className={cx('ui-button--icon', className)}
      {...(disabledReason ? { disabledReason } : {})}
      {...rest}
    />
  );
  if (disabledReason) return button;
  return (
    <Tooltip
      content={label}
      {...(shortcut ? { shortcut } : {})}
      {...(tooltipSide ? { side: tooltipSide } : {})}
    >
      {button}
    </Tooltip>
  );
});
