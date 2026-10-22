import { forwardRef, type ReactNode } from 'react';
import { ContextMenu as Primitive } from 'radix-ui';
import { cx } from '../internal/cx.js';
import { portalRoot } from '../internal/portal.js';
import { renderMenuBody } from './Menu.js';
import type { MenuGroup, MenuItem, MenuRadio } from './menu-items.js';
import './Menu.css';

export interface ContextMenuProps {
  children: ReactNode;
  items?: MenuItem[];
  groups?: MenuGroup[];
  radio?: MenuRadio;
  label?: string;
  className?: string;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

type SharedMenuNamespace = Parameters<typeof renderMenuBody>[0];

export const ContextMenu = forwardRef<HTMLDivElement, ContextMenuProps>(function ContextMenu(
  { children, items, groups, radio, label, className, onOpenChange, onCloseAutoFocus },
  ref,
) {
  return (
    <Primitive.Root {...(onOpenChange ? { onOpenChange } : {})}>
      <Primitive.Trigger asChild>{children}</Primitive.Trigger>
      <Primitive.Portal container={portalRoot()}>
        <Primitive.Content
          ref={ref}
          className={cx('ui-menu', className)}
          data-ui-portal="popover"
          collisionPadding={8}
          aria-label={label}
          {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}
        >
          {renderMenuBody(Primitive as unknown as SharedMenuNamespace, { items, groups, radio })}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
});
