import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { AlertDialog as Primitive } from 'radix-ui';
import { Button } from '../Button/Button.js';
import { Callout } from '../Callout/Callout.js';
import { Input } from '../Input/Input.js';
import { cx } from '../internal/cx.js';
import { portalRoot } from '../internal/portal.js';
import '../Dialog/Dialog.css';
import './ConfirmDialog.css';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  body?: ReactNode;
  /** Verb plus object: "Delete project", "Revoke session". */
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
  /** The exact text the user must type before Confirm is enabled (the object's name). */
  typeToConfirm?: string;
  /** Resolves when done (the dialog closes); rejects to show the error with a retry. */
  onConfirm: () => Promise<void>;
  /**
   * Overrides the accessible name, title or not, where a test pins it
   * ("Confirm delete"). The title stays the visible heading.
   */
  ariaLabel?: string;
  className?: string;
}

/**
 * Radix AlertDialog: nothing outside it is reachable until it closes, Esc
 * cancels, and focus returns to the opener. For danger, focus starts on
 * Cancel so an extra Enter does nothing destructive.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'default',
  typeToConfirm,
  onConfirm,
  ariaLabel,
  className,
}: ConfirmDialogProps): ReactElement {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [typed, setTyped] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const mounted = useRef(true);
  // Opened from state, so there is no Radix Trigger to return focus to.
  const opener = useRef<Element | null>(null);
  useLayoutEffect(() => {
    if (open) opener.current = document.activeElement;
  }, [open]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Each opening starts clean.
  useEffect(() => {
    if (open) {
      setPending(false);
      setError(undefined);
      setTyped('');
    }
  }, [open]);

  const matches = !typeToConfirm || typed === typeToConfirm;

  const confirm = (): void => {
    if (!matches || pending) return;
    setPending(true);
    setError(undefined);
    onConfirm().then(
      () => {
        if (!mounted.current) return;
        setPending(false);
        onOpenChange(false);
      },
      (reason: unknown) => {
        if (!mounted.current) return;
        setPending(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <Primitive.Root
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <Primitive.Portal container={portalRoot()}>
        <Primitive.Overlay className="ui-dialog__overlay" data-ui-portal="dialog" />
        <Primitive.Content
          className={cx('ui-dialog', 'ui-dialog--sm', 'ui-confirm', className)}
          data-ui-portal="dialog"
          // Radix names the dialog by its title; a given label has to replace
          // that reference, or the title would still win.
          {...(ariaLabel ? { 'aria-label': ariaLabel, 'aria-labelledby': undefined } : {})}
          onOpenAutoFocus={(event) => {
            const target = typeToConfirm
              ? document.getElementById(inputId)
              : tone === 'danger'
                ? cancelRef.current
                : confirmRef.current;
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
          </header>
          <div className="ui-dialog__body ui-confirm__body">
            {body ? (
              <Primitive.Description asChild>
                <div className="ui-confirm__text">{body}</div>
              </Primitive.Description>
            ) : null}
            {typeToConfirm ? (
              <div className="ui-confirm__type">
                <label htmlFor={inputId} className="ui-confirm__label">
                  Type <strong>{typeToConfirm}</strong> to confirm
                </label>
                <Input
                  id={inputId}
                  value={typed}
                  mono
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setTyped(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      confirm();
                    }
                  }}
                />
              </div>
            ) : null}
            {error ? (
              <Callout tone="danger" title={error}>
                Try again, or cancel.
              </Callout>
            ) : null}
          </div>
          <footer className="ui-dialog__footer">
            <Primitive.Cancel asChild>
              <Button ref={cancelRef} variant="ghost" disabled={pending}>
                {cancelLabel}
              </Button>
            </Primitive.Cancel>
            <Button
              ref={confirmRef}
              variant={tone === 'danger' ? 'danger' : 'primary'}
              loading={pending}
              onClick={confirm}
              {...(!matches ? { disabledReason: `Type ${typeToConfirm} to confirm` } : {})}
            >
              {error ? `Retry: ${confirmLabel}` : confirmLabel}
            </Button>
          </footer>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
