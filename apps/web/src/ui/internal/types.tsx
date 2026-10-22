import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { Icon } from '../icons.js';

export type Size = 'sm' | 'md' | 'lg';
export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent';

/** An icon slot takes either a Phosphor icon component or a ready element. */
export type IconLike = Icon | ReactElement;

/** Renders an icon slot at the given size; decorative unless it is an element with its own label. */
export function renderIcon(icon: IconLike | undefined, size = 16): ReactNode {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  const Component = icon;
  return <Component size={size} aria-hidden="true" />;
}
