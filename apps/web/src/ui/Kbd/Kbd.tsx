import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { cx } from '../internal/cx.js';
import { isApplePlatform } from '../internal/platform.js';
import './Kbd.css';

export interface KbdProps extends ComponentPropsWithoutRef<'kbd'> {
  /** Keys in press order. 'Mod' becomes Command on Apple platforms and Ctrl elsewhere. */
  keys: string[];
}

const APPLE_GLYPHS: Record<string, string> = {
  Mod: '⌘',
  Cmd: '⌘',
  Meta: '⌘',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧',
  Ctrl: '⌃',
  Control: '⌃',
  Enter: '↩',
  Backspace: '⌫',
  Escape: 'Esc',
};

const OTHER_NAMES: Record<string, string> = {
  Mod: 'Ctrl',
  Cmd: 'Ctrl',
  Meta: 'Win',
  Control: 'Ctrl',
  Option: 'Alt',
  Escape: 'Esc',
};

/** How a key reads on the current platform, for a label or an accessible name. */
export function keyLabel(key: string, apple = isApplePlatform()): string {
  const table = apple ? APPLE_GLYPHS : OTHER_NAMES;
  return table[key] ?? key;
}

/** The shortcut as one string, for aria-labels and tooltips ("Ctrl+K"). */
export function shortcutLabel(keys: string[], apple = isApplePlatform()): string {
  return keys.map((key) => keyLabel(key, apple)).join(apple ? '' : '+');
}

export const Kbd = forwardRef<HTMLElement, KbdProps>(function Kbd(
  { keys, className, ...rest },
  ref,
) {
  const apple = isApplePlatform();
  return (
    <kbd
      ref={ref}
      className={cx('ui-kbd', className)}
      aria-label={shortcutLabel(keys, apple)}
      {...rest}
    >
      {keys.map((key, index) => (
        <span key={`${key}-${index}`} className="ui-kbd__key" aria-hidden="true">
          {keyLabel(key, apple)}
        </span>
      ))}
    </kbd>
  );
});
