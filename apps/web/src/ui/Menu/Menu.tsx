import { forwardRef, type ReactElement, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { DropdownMenu as Primitive } from 'radix-ui';
import { Kbd } from '../Kbd/Kbd.js';
import { CaretRight, Check } from '../icons.js';
import { cx } from '../internal/cx.js';
import { downloadProp } from '../internal/download.js';
import { portalRoot } from '../internal/portal.js';
import { renderIcon } from '../internal/types.js';
import { menuItemKey, type MenuGroup, type MenuItem, type MenuRadio } from './menu-items.js';
import './Menu.css';

export type { MenuGroup, MenuItem, MenuRadio } from './menu-items.js';

export interface MenuProps {
  trigger: ReactElement;
  items?: MenuItem[];
  groups?: MenuGroup[];
  radio?: MenuRadio;
  label?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  className?: string;
}

type MenuNamespace = typeof Primitive;

export function MenuItemContent({ item }: { item: MenuItem }): ReactElement {
  return (
    <>
      {item.checked !== undefined ? (
        <span className="ui-menu__check" aria-hidden="true">
          {item.checked ? <Check size={16} /> : null}
        </span>
      ) : (
        <span className="ui-menu__icon" aria-hidden="true">
          {renderIcon(item.icon)}
        </span>
      )}
      <span className="ui-menu__text">
        <span className="ui-menu__label">{item.label}</span>
        {item.disabledReason ? (
          <span className="ui-menu__reason">{item.disabledReason}</span>
        ) : null}
      </span>
      {item.shortcut ? <Kbd keys={item.shortcut} className="ui-menu__shortcut" /> : null}
      {item.items ? <CaretRight size={12} className="ui-menu__caret" aria-hidden="true" /> : null}
    </>
  );
}

export function renderMenuItems(ns: MenuNamespace, items: MenuItem[]): ReactNode {
  return items.map((item, index) => {
    const key = menuItemKey(item, index);
    const className = cx('ui-menu__item', item.tone === 'danger' && 'ui-menu__item--danger');
    const disabled = Boolean(item.disabledReason);

    if (item.items) {
      return (
        <ns.Sub key={key}>
          <ns.SubTrigger className={className} disabled={disabled}>
            <MenuItemContent item={item} />
          </ns.SubTrigger>
          <ns.Portal container={portalRoot()}>
            <ns.SubContent className="ui-menu" data-ui-portal="popover" sideOffset={4}>
              {renderMenuItems(ns, item.items)}
            </ns.SubContent>
          </ns.Portal>
        </ns.Sub>
      );
    }

    if (item.checked !== undefined) {
      return (
        <ns.CheckboxItem
          key={key}
          className={className}
          checked={item.checked}
          disabled={disabled}
          onCheckedChange={() => item.onSelect?.()}
        >
          <MenuItemContent item={item} />
        </ns.CheckboxItem>
      );
    }

    if (item.to && !disabled) {
      return (
        <ns.Item
          key={key}
          className={className}
          asChild
          {...(item.onSelect ? { onSelect: item.onSelect } : {})}
        >
          <Link to={item.to}>
            <MenuItemContent item={item} />
          </Link>
        </ns.Item>
      );
    }

    if (item.href && !disabled) {
      return (
        <ns.Item
          key={key}
          className={className}
          asChild
          {...(item.onSelect ? { onSelect: item.onSelect } : {})}
        >
          <a href={item.href} {...downloadProp(item.download)}>
            <MenuItemContent item={item} />
          </a>
        </ns.Item>
      );
    }

    return (
      <ns.Item
        key={key}
        className={className}
        disabled={disabled}
        {...(item.onSelect ? { onSelect: item.onSelect } : {})}
      >
        <MenuItemContent item={item} />
      </ns.Item>
    );
  });
}

export interface MenuBody {
  items?: MenuItem[] | undefined;
  groups?: MenuGroup[] | undefined;
  radio?: MenuRadio | undefined;
}

export function renderMenuBody(ns: MenuNamespace, { items, groups, radio }: MenuBody): ReactNode {
  const parts: ReactNode[] = [];
  if (items?.length) parts.push(<ns.Group key="items">{renderMenuItems(ns, items)}</ns.Group>);
  groups?.forEach((group, index) => {
    parts.push(
      <ns.Group key={`group-${index}`} className="ui-menu__group">
        {group.label ? <ns.Label className="ui-menu__heading">{group.label}</ns.Label> : null}
        {renderMenuItems(ns, group.items)}
      </ns.Group>,
    );
  });
  if (radio) {
    parts.push(
      <ns.RadioGroup
        key="radio"
        className="ui-menu__group"
        value={radio.value}
        onValueChange={radio.onValueChange}
      >
        {radio.label ? <ns.Label className="ui-menu__heading">{radio.label}</ns.Label> : null}
        {radio.items.map((option) => (
          <ns.RadioItem
            key={option.value}
            value={option.value}
            className="ui-menu__item"
            disabled={Boolean(option.disabledReason)}
          >
            <span className="ui-menu__check" aria-hidden="true">
              <ns.ItemIndicator>
                <Check size={16} />
              </ns.ItemIndicator>
            </span>
            <span className="ui-menu__text">
              <span className="ui-menu__label">{option.label}</span>
              {option.disabledReason ? (
                <span className="ui-menu__reason">{option.disabledReason}</span>
              ) : null}
            </span>
          </ns.RadioItem>
        ))}
      </ns.RadioGroup>,
    );
  }
  return parts.flatMap((part, index) =>
    index === 0
      ? [part]
      : [<ns.Separator key={`sep-${index}`} className="ui-menu__separator" />, part],
  );
}

export const Menu = forwardRef<HTMLDivElement, MenuProps>(function Menu(
  {
    trigger,
    items,
    groups,
    radio,
    label,
    side = 'bottom',
    align = 'end',
    open,
    onOpenChange,
    onCloseAutoFocus,
    className,
  },
  ref,
) {
  return (
    <Primitive.Root
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <Primitive.Trigger asChild>{trigger}</Primitive.Trigger>
      <Primitive.Portal container={portalRoot()}>
        <Primitive.Content
          ref={ref}
          className={cx('ui-menu', className)}
          data-ui-portal="popover"
          side={side}
          align={align}
          sideOffset={4}
          collisionPadding={8}
          aria-label={label}
          {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}
        >
          {renderMenuBody(Primitive, { items, groups, radio })}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
});
