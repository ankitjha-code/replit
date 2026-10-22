import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { Tabs as Primitive } from 'radix-ui';
import { Badge } from '../Badge/Badge.js';
import { cx } from '../internal/cx.js';
import { renderIcon, type IconLike } from '../internal/types.js';
import './Tabs.css';

export interface TabItem {
  value: string;
  label: ReactNode;
  icon?: IconLike;
  badge?: ReactNode;
  disabledReason?: string;
}

export interface TabsProps extends Omit<
  ComponentPropsWithoutRef<typeof Primitive.Root>,
  'orientation'
> {
  items: TabItem[];
  variant?: 'line' | 'segmented';
  /** Names the tab list for assistive technology. */
  label?: string;
  /** TabPanel children, one per item. */
  children?: ReactNode;
}

/**
 * Radix Tabs: arrows move between tabs, Home/End jump, each tab controls its
 * panel. A disabled tab keeps its reason beside the label so the user is not
 * left with a dead tab.
 */
export const Tabs = forwardRef<HTMLDivElement, TabsProps>(function Tabs(
  { items, variant = 'line', label, className, children, ...rest },
  ref,
) {
  return (
    <Primitive.Root ref={ref} className={cx('ui-tabs', `ui-tabs--${variant}`, className)} {...rest}>
      <Primitive.List className="ui-tabs__list" aria-label={label}>
        {items.map((item) => (
          <Primitive.Trigger
            key={item.value}
            value={item.value}
            className="ui-tabs__tab"
            disabled={Boolean(item.disabledReason)}
            title={item.disabledReason}
          >
            {renderIcon(item.icon)}
            <span className="ui-tabs__label">{item.label}</span>
            {item.badge !== undefined && item.badge !== null ? (
              <Badge tone="neutral" className="ui-tabs__badge">
                {item.badge}
              </Badge>
            ) : null}
            {item.disabledReason ? (
              <span className="visually-hidden">{item.disabledReason}</span>
            ) : null}
          </Primitive.Trigger>
        ))}
      </Primitive.List>
      {children}
    </Primitive.Root>
  );
});

export type TabPanelProps = ComponentPropsWithoutRef<typeof Primitive.Content>;

export const TabPanel = forwardRef<HTMLDivElement, TabPanelProps>(function TabPanel(
  { className, ...rest },
  ref,
) {
  return <Primitive.Content ref={ref} className={cx('ui-tabs__panel', className)} {...rest} />;
});
