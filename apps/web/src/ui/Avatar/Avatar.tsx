import { forwardRef, type ReactElement } from 'react';
import { Avatar as Primitive } from 'radix-ui';
import { cx } from '../internal/cx.js';
import './Avatar.css';

export interface AvatarProps {
  name: string;
  color?: string;
  userId?: string;
  src?: string;
  size?: 20 | 24 | 32;
  className?: string;
}

export function initialsOf(name: string): string {
  const parts = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '').slice(0, 2).toUpperCase();
  return `${parts[0]?.[0] ?? ''}${parts[parts.length - 1]?.[0] ?? ''}`.toUpperCase();
}

export function presenceIndex(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return (hash % 8) + 1;
}

export const Avatar = forwardRef<HTMLSpanElement, AvatarProps>(function Avatar(
  { name, color, userId, src, size = 24, className },
  ref,
) {
  const background = color ?? `var(--presence-${presenceIndex(userId ?? name)})`;
  return (
    <Primitive.Root
      ref={ref}
      className={cx('ui-avatar', `ui-avatar--${size}`, className)}
      style={{ background }}
      title={name}
      role="img"
      aria-label={name}
    >
      {src ? <Primitive.Image className="ui-avatar__image" src={src} alt="" /> : null}
      <Primitive.Fallback className="ui-avatar__fallback" {...(src ? { delayMs: 300 } : {})}>
        {initialsOf(name)}
      </Primitive.Fallback>
    </Primitive.Root>
  );
});

export interface AvatarGroupProps {
  people: Array<Pick<AvatarProps, 'name' | 'color' | 'userId' | 'src'>>;
  max?: number;
  size?: AvatarProps['size'];
  className?: string;
}

export function AvatarGroup({
  people,
  max = 4,
  size = 24,
  className,
}: AvatarGroupProps): ReactElement {
  const shown = people.slice(0, max);
  const rest = people.slice(max);
  return (
    <span
      className={cx('ui-avatar-group', className)}
      role="group"
      aria-label={`${people.length} people`}
    >
      {shown.map((person, index) => (
        <Avatar key={`${person.userId ?? person.name}-${index}`} size={size} {...person} />
      ))}
      {rest.length ? (
        <span
          className={cx('ui-avatar', `ui-avatar--${size}`, 'ui-avatar--more')}
          title={rest.map((person) => person.name).join(', ')}
          aria-label={`${rest.length} more: ${rest.map((person) => person.name).join(', ')}`}
          role="img"
        >
          +{rest.length}
        </span>
      ) : null}
    </span>
  );
}
