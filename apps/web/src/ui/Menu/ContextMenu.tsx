import { forwardRef, type ReactNode } from 'react';
import { ContextMenu as Primitive } from 'radix-ui';
import { cx } from '../internal/cx.js';
import { portalRoot } from '../internal/portal.js';
import { renderMenuBody } from './Menu.js';
import type { MenuGroup, MenuItem, MenuRadio } from './menu-items.js';
import './Menu.css';

export interface ContextMenuProps {
  /** The area that opens the menu on right-click, Shift+F10 or the Menu key. */
  children: ReactNode;
  items?: MenuItem[];
  groups?: MenuGroup[];
  radio?: MenuRadio;
  label?: string;
  className?: string;
  onOpenChange?: (open: boolean) => void;
  /** As on Menu: prevent it to keep focus where an item put it. */
  onCloseAutoFocus?: (event: Event) => void;
}

/*
 * The Radix context and dropdown menus share item semantics but not types;
 * the item renderers only use the members both namespaces have.
 */
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
