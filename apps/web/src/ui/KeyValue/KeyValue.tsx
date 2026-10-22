import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { Button } from '../Button/Button.js';
import { Callout } from '../Callout/Callout.js';
import { CopyButton } from '../CopyButton/CopyButton.js';
import { Skeleton } from '../Skeleton/Skeleton.js';
import { cx } from '../internal/cx.js';
import './KeyValue.css';

export interface KeyValueItem {
  term: ReactNode;
  value: ReactNode;
  copy?: string;
  mono?: boolean;
}

export interface KeyValueProps extends Omit<ComponentPropsWithoutRef<'dl'>, 'children'> {
  items: KeyValueItem[];
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  placeholderRows?: number;
}

export const KeyValue = forwardRef<HTMLDListElement, KeyValueProps>(function KeyValue(
  { items, loading = false, error, onRetry, placeholderRows = 3, className, ...rest },
  ref,
) {
  if (error) {
    return (
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
    );
  }
  return (
    <dl
      ref={ref}
      className={cx('ui-key-value', className)}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading
        ? Array.from({ length: placeholderRows }, (_, index) => (
            <div key={index} className="ui-key-value__row">
              <dt className="ui-key-value__term">
                <Skeleton width={80} height={12} />
              </dt>
              <dd className="ui-key-value__value">
                <Skeleton width={160} height={12} />
              </dd>
            </div>
          ))
        : items.map((item, index) => (
            <div key={index} className="ui-key-value__row">
              <dt className="ui-key-value__term">{item.term}</dt>
              <dd className={cx('ui-key-value__value', item.mono && 'ui-key-value__value--mono')}>
                <span className="ui-key-value__text">{item.value}</span>
                {item.copy !== undefined ? (
                  <CopyButton
                    value={item.copy}
                    label={
                      typeof item.term === 'string' ? `Copy ${item.term.toLowerCase()}` : 'Copy'
                    }
                  />
                ) : null}
              </dd>
            </div>
          ))}
    </dl>
  );
});
