import { forwardRef, type ReactNode } from 'react';
import { ToggleGroup as Primitive } from 'radix-ui';
import { cx } from '../internal/cx.js';
import { renderIcon, type IconLike, type Size } from '../internal/types.js';
import './SegmentedControl.css';

export interface SegmentedItem {
  value: string;
  label: ReactNode;
  icon?: IconLike;
  disabledReason?: string;
  /** Icon only; the label becomes the accessible name. */
  iconOnly?: boolean;
}

export interface SegmentedControlProps {
  items: SegmentedItem[];
  value: string;
  onValueChange: (value: string) => void;
  /** Names the group. */
  label: string;
  size?: Size;
  className?: string;
}

/** Radix ToggleGroup, single: arrows move, one item is always selected. */
export const SegmentedControl = forwardRef<HTMLDivElement, SegmentedControlProps>(
  function SegmentedControl({ items, value, onValueChange, label, size = 'md', className }, ref) {
    return (
      <Primitive.Root
        ref={ref}
        type="single"
        value={value}
        onValueChange={(next) => {
          // Radix reports '' when the active item is pressed again; one stays selected.
          if (next) onValueChange(next);
        }}
        className={cx('ui-segmented', `ui-segmented--${size}`, className)}
        aria-label={label}
      >
        {items.map((item) => (
          <Primitive.Item
            key={item.value}
            value={item.value}
            className="ui-segmented__item"
            disabled={Boolean(item.disabledReason)}
            title={item.disabledReason}
            aria-label={item.iconOnly && typeof item.label === 'string' ? item.label : undefined}
          >
            {renderIcon(item.icon)}
            {item.iconOnly ? null : <span>{item.label}</span>}
            {item.disabledReason ? (
              <span className="visually-hidden">{item.disabledReason}</span>
            ) : null}
          </Primitive.Item>
        ))}
      </Primitive.Root>
    );
  },
);
