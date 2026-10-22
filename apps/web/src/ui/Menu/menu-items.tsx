import type { ReactNode } from 'react';
import type { IconLike } from '../internal/types.js';

export interface MenuItem {
  id?: string;
  label: ReactNode;
  icon?: IconLike;
  shortcut?: string[];
  tone?: 'default' | 'danger';
  disabledReason?: string;
  checked?: boolean;
  onSelect?: () => void;
  to?: string;
  href?: string;
  download?: string | boolean;
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
