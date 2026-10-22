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
  /** 400 / 560 / 800px. */
  size?: DialogSize;
  footer?: ReactNode;
  /** Receives focus when the dialog opens; defaults to the first focusable element. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** The body shows a skeleton while its data loads. */
  loading?: boolean;
  /** The body shows this error with a Retry instead of an empty box. */
  error?: string;
  onRetry?: () => void;
  className?: string;
  children?: ReactNode;
  /** The trigger, when the dialog manages its own opener; otherwise control `open`. */
  trigger?: ReactElement;
}

/** Focus is trapped, Esc closes, focus returns to the opener (all Radix). */
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
  // Radix returns focus to its Trigger; a dialog opened from state has none,
  // so the element focused at open is remembered and restored by hand.
  const opener = useRef<Element | null>(null);
  useLayoutEffect(() => {
    // Before Radix moves focus into the dialog (its effects run later).
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
            // The body's first control, not the Close button in the header.
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
