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
  loading?: boolean;
  loadingLabel?: string;
  disabledReason?: string;
  asChild?: boolean;
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
