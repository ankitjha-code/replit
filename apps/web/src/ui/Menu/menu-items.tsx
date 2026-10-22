import type { ReactNode } from 'react';
import type { IconLike } from '../internal/types.js';

export interface MenuItem {
  /** Stable key; defaults to the label when it is a string. */
  id?: string;
  label: ReactNode;
  icon?: IconLike;
  shortcut?: string[];
  tone?: 'default' | 'danger';
  /** Disables the item and shows why beneath its label. */
  disabledReason?: string;
  /** A checkbox item. */
  checked?: boolean;
  onSelect?: () => void;
  /** A link item (react-router). */
  to?: string;
  /** A plain link, for a file download or another origin; `to` wins when both are set. */
  href?: string;
  /** With `href`: download instead of navigating (a file name, or true for the server's). */
  download?: string | boolean;
  /** A submenu. */
  items?: MenuItem[];
}

export interface MenuGroup {
  label?: ReactNode;
  items: MenuItem[];
}

export interface MenuRadio {
  value: string;
  onValueChange: (value: string) => void;
  items: Array<{ value: string; label: ReactNode; icon?: IconLike; disabledReason?: string }>;
  label?: ReactNode;
}

export function menuItemKey(item: MenuItem, index: number): string {
  if (item.id) return item.id;
  return typeof item.label === 'string' ? item.label : `item-${index}`;
}
