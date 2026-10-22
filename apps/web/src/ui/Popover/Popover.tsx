import {
  forwardRef,
  useId,
  useRef,
  useImperativeHandle,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { Popover as Primitive } from 'radix-ui';
import { Button } from '../Button/Button.js';
import { Callout } from '../Callout/Callout.js';
import { IconButton } from '../IconButton/IconButton.js';
import { Skeleton } from '../Skeleton/Skeleton.js';
import { X } from '../icons.js';
import { cx } from '../internal/cx.js';
import { firstTabbable } from '../internal/focus.js';
import { portalRoot } from '../internal/portal.js';
import './Popover.css';

export interface PopoverProps {
  trigger: ReactElement;
  title?: ReactNode;
  children?: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  label?: string;
  initialFocus?: RefObject<HTMLElement | null> | undefined;
}

export const Popover = forwardRef<HTMLDivElement, PopoverProps>(function Popover(
  {
    trigger,
    title,
    children,
    side = 'bottom',
    align = 'start',
    loading = false,
    error,
    onRetry,
    open,
    onOpenChange,
    className,
    label,
    initialFocus,
  },
  ref,
) {
  const titleId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => contentRef.current as HTMLDivElement);
  return (
    <Primitive.Root
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <Primitive.Trigger asChild>{trigger}</Primitive.Trigger>
      <Primitive.Portal container={portalRoot()}>
        <Primitive.Content
          ref={contentRef}
          className={cx('ui-popover', className)}
          onOpenAutoFocus={(event) => {
            const target =
              initialFocus?.current ??
              firstTabbable(contentRef.current?.querySelector('.ui-popover__body')) ??
              contentRef.current;
            if (target) {
              event.preventDefault();
              target.focus();
            }
          }}
          data-ui-portal="popover"
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          aria-label={label}
          aria-labelledby={title && !label ? titleId : undefined}
        >
          {title ? (
            <header className="ui-popover__header">
              <h2 id={titleId} className="ui-popover__title">
                {title}
              </h2>
              <Primitive.Close asChild>
                <IconButton label="Close" icon={X} size="sm" />
              </Primitive.Close>
            </header>
          ) : null}
          <div className="ui-popover__body" aria-busy={loading || undefined}>
            {loading ? (
              <Skeleton lines={3} />
            ) : error ? (
              <Callout
                tone="danger"
                title={error}
                action={
                  onRetry ? (
                    <Button size="sm" onClick={onRetry}>
                      Retry
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              children
            )}
          </div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
});
