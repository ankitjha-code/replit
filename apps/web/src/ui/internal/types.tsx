import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { Icon } from '../icons.js';

export type Size = 'sm' | 'md' | 'lg';
export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent';

export type IconLike = Icon | ReactElement;

export function renderIcon(icon: IconLike | undefined, size = 16): ReactNode {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  const Component = icon;
  return <Component size={size} aria-hidden="true" />;
}
