import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../Button/Button.js';
import { IconButton } from '../IconButton/IconButton.js';
import { Menu, type MenuItem } from '../Menu/Menu.js';
import { Tooltip } from '../Tooltip/Tooltip.js';
import { DotsThree } from '../icons.js';
import { cx } from '../internal/cx.js';
import { downloadProp } from '../internal/download.js';
import type { IconLike } from '../internal/types.js';
import './RowActions.css';

export interface RowAction {
  label: string;
  icon: IconLike;
  onSelect?: () => void;
  /** Renders the action as a link (react-router) rather than a button. */
  to?: string;
  /** A plain link, such as a file download; `to` wins when both are set. */
  href?: string;
  /** With `href`: download instead of navigating (a file name, or true for the server's). */
  download?: string | boolean;
  tone?: 'default' | 'danger';
  disabledReason?: string;
}

export interface RowActionsProps extends Omit<ComponentPropsWithoutRef<'div'>, 'children'> {
  items: RowAction[];
  /** The row's name, so every action reads "Remove alice", never just "Remove". */
  objectName: string;
  /** How many show as icon buttons before the rest move into a menu. */
  inline?: number;
}

export function rowActionName(label: string, objectName: string): string {
  return `${label} ${objectName}`;
}

/** Actions at the right end of every row, in the same place, named after the row. */
export const RowActions = forwardRef<HTMLDivElement, RowActionsProps>(function RowActions(
  { items, objectName, inline = 2, className, ...rest },
  ref,
) {
  const overflow = items.length > inline;
  const visible = overflow ? [] : items;
  const menuItems: MenuItem[] = overflow
    ? items.map((item) => ({
        label: rowActionName(item.label, objectName),
        icon: item.icon,
        ...(item.onSelect ? { onSelect: item.onSelect } : {}),
        ...(item.to ? { to: item.to } : {}),
        ...(item.href ? { href: item.href } : {}),
        ...(item.download !== undefined ? { download: item.download } : {}),
        ...(item.tone ? { tone: item.tone } : {}),
        ...(item.disabledReason ? { disabledReason: item.disabledReason } : {}),
      }))
    : [];
  return (
    <div ref={ref} className={cx('ui-row-actions', className)} {...rest}>
      {visible.map((item) =>
        (item.to || item.href) && !item.disabledReason ? (
          <LinkAction key={item.label} item={item} name={rowActionName(item.label, objectName)} />
        ) : (
          <IconButton
            key={item.label}
            size="sm"
            label={rowActionName(item.label, objectName)}
            icon={item.icon}
            className={cx(item.tone === 'danger' && 'ui-row-actions__danger')}
            {...(item.onSelect ? { onClick: item.onSelect } : {})}
            {...(item.disabledReason ? { disabledReason: item.disabledReason } : {})}
          />
        ),
      )}
      {overflow ? (
        <Menu
          trigger={<IconButton size="sm" label={`Actions for ${objectName}`} icon={DotsThree} />}
          items={menuItems}
        />
      ) : null}
    </div>
  );
});

/**
 * An inline action that goes somewhere: an icon-only link dressed like the
 * row's icon buttons, named and tooltipped the same way. The name sits in
 * `aria-label` on the anchor itself (a hidden span inside an anchor computes
 * an unexpected name under jsdom).
 */
function LinkAction({ item, name }: { item: RowAction; name: string }): React.JSX.Element {
  const onClick = item.onSelect ? { onClick: item.onSelect } : {};
  return (
    <Tooltip content={name}>
      <Button
        asChild
        size="sm"
        variant="ghost"
        icon={item.icon}
        className={cx('ui-button--icon', item.tone === 'danger' && 'ui-row-actions__danger')}
      >
        {item.to ? (
          <Link to={item.to} aria-label={name} {...onClick} />
        ) : (
          <a href={item.href} aria-label={name} {...downloadProp(item.download)} {...onClick} />
        )}
      </Button>
    </Tooltip>
  );
}
