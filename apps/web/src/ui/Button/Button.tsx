import {
  forwardRef,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type MouseEvent,
} from 'react';
import { Slot } from 'radix-ui';
import { Spinner } from '../Spinner/Spinner.js';
import { DisabledReason, describedBy } from '../internal/DisabledReason.js';
import { cx } from '../internal/cx.js';
import { renderIcon, type IconLike, type Size } from '../internal/types.js';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';

export interface ButtonProps extends ComponentPropsWithoutRef<'button'> {
  variant?: ButtonVariant;
  size?: Size;
  icon?: IconLike;
  iconEnd?: IconLike;
  /** The spinner replaces the leading icon; the label and the width stay. */
  loading?: boolean;
  /** Announced to assistive technology while loading, without changing the button's name. */
  loadingLabel?: string;
  /** Disables the button and explains why, by tooltip and by aria-describedby. */
  disabledReason?: string;
  /** Render the child (a Link, an anchor, a label) with button styling. */
  asChild?: boolean;
  /**
   * For a button whose `disabledReason` comes and goes (Start, Run): keeps the
   * reason's wrapper in place throughout, so the button element survives the
   * change and focus or a test's reference to it stays valid. Off by default
   * because the wrapper is an extra element around the button.
   */
  keepReasonWrapper?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon,
    iconEnd,
    loading = false,
    loadingLabel,
    disabledReason,
    disabled,
    asChild = false,
    keepReasonWrapper = false,
    className,
    children,
    onClick,
    type,
    'aria-describedby': ariaDescribedBy,
    ...rest
  },
  forwardedRef,
) {
  const reasonId = useId();
  const loadingId = useId();
  const ref = useRef<HTMLButtonElement>(null);
  const idleWidth = useRef(0);
  useImperativeHandle(forwardedRef, () => ref.current as HTMLButtonElement);

  // Lock the idle width while loading so a row of buttons never shifts when
  // one of them swaps its icon for a spinner.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (loading) {
      if (idleWidth.current > 0) element.style.minWidth = `${idleWidth.current}px`;
      return;
    }
    element.style.minWidth = '';
    idleWidth.current = element.offsetWidth;
  });

  const isDisabled = Boolean(disabled) || Boolean(disabledReason);
  const Component = asChild ? Slot.Root : 'button';

  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (loading) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  // Slot needs Slottable as a direct child, so the parts are siblings, not a fragment.
  const leading = loading ? (
    <Spinner
      key="spinner"
      size={size === 'sm' ? 12 : 16}
      className="ui-button__spinner"
      aria-hidden="true"
    />
  ) : (
    renderIcon(icon)
  );
  const label = asChild ? <Slot.Slottable key="label">{children}</Slot.Slottable> : children;

  const button = (
    <Component
      ref={ref}
      type={asChild ? undefined : (type ?? 'button')}
      className={cx(
        'ui-button',
        `ui-button--${variant}`,
        `ui-button--${size}`,
        loading && 'ui-button--loading',
        className,
      )}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      aria-disabled={loading ? true : undefined}
      aria-describedby={describedBy(
        ariaDescribedBy,
        disabledReason ? reasonId : undefined,
        loading && loadingLabel ? loadingId : undefined,
      )}
      onClick={handleClick}
      {...rest}
    >
      {leading}
      {label}
      {renderIcon(iconEnd)}
    </Component>
  );

  // The loading label sits beside the button, not inside it, so it describes
  // the button without becoming part of its name. Always one fragment with the
  // button first, so the button element survives the label coming and going.
  const withLoadingLabel = (
    <>
      {button}
      {loading && loadingLabel ? (
        <span id={loadingId} className="visually-hidden">
          {loadingLabel}
        </span>
      ) : null}
    </>
  );

  if (!disabledReason && !keepReasonWrapper) return withLoadingLabel;
  return (
    <DisabledReason id={reasonId} reason={disabledReason} persistent={keepReasonWrapper}>
      {withLoadingLabel}
    </DisabledReason>
  );
});
