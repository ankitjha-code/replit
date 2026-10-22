import { useLayoutEffect, useRef, type ReactElement, type ReactNode, type RefObject } from 'react';
import { Dialog as Primitive } from 'radix-ui';
import { Callout } from '../Callout/Callout.js';
import { Button } from '../Button/Button.js';
import { IconButton } from '../IconButton/IconButton.js';
import { Skeleton } from '../Skeleton/Skeleton.js';
import { X } from '../icons.js';
import { cx } from '../internal/cx.js';
import { firstTabbable } from '../internal/focus.js';
import { portalRoot } from '../internal/portal.js';
import './Dialog.css';

export type DialogSize = 'sm' | 'md' | 'lg';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  size?: DialogSize;
  footer?: ReactNode;
  initialFocus?: RefObject<HTMLElement | null>;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  className?: string;
  children?: ReactNode;
  trigger?: ReactElement;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  size = 'md',
  footer,
  initialFocus,
  loading = false,
  error,
  onRetry,
  className,
  children,
  trigger,
}: DialogProps): ReactElement {
  const contentRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  useLayoutEffect(() => {
    if (open) opener.current = document.activeElement;
  }, [open]);
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <Primitive.Trigger asChild>{trigger}</Primitive.Trigger> : null}
      <Primitive.Portal container={portalRoot()}>
        <Primitive.Overlay className="ui-dialog__overlay" data-ui-portal="dialog" />
        <Primitive.Content
          ref={contentRef}
          className={cx('ui-dialog', `ui-dialog--${size}`, className)}
          data-ui-portal="dialog"
          onOpenAutoFocus={(event) => {
            const target =
              initialFocus?.current ??
              firstTabbable(contentRef.current?.querySelector('.ui-dialog__body')) ??
              firstTabbable(contentRef.current?.querySelector('.ui-dialog__footer')) ??
              contentRef.current;
            if (target) {
              event.preventDefault();
              target.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            const target = opener.current;
            if (target instanceof HTMLElement && target.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          <header className="ui-dialog__header">
            <Primitive.Title className="ui-dialog__title">{title}</Primitive.Title>
            <Primitive.Close asChild>
              <IconButton label="Close" icon={X} size="sm" className="ui-dialog__close" />
            </Primitive.Close>
          </header>
          {description ? (
            <Primitive.Description className="ui-dialog__description">
              {description}
            </Primitive.Description>
          ) : null}
          <div className="ui-dialog__body" aria-busy={loading || undefined}>
            {loading ? (
              <Skeleton lines={3} />
            ) : error ? (
              <Callout
                tone="danger"
                title={error}
                action={
                  onRetry ? (
                    <Button size="md" onClick={onRetry}>
                      Retry
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              children
            )}
          </div>
          {footer ? <footer className="ui-dialog__footer">{footer}</footer> : null}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
