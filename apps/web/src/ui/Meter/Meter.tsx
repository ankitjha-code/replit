import { forwardRef, type CSSProperties, type ComponentPropsWithoutRef } from 'react';
import { cx } from '../internal/cx.js';
import './Meter.css';

export interface MeterProps extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
  value: number | null;
  max: number;
  label: string;
  format?: (value: number) => string;
  tone?: 'neutral' | 'warn' | 'danger';
  loading?: boolean;
  labelWidth?: string;
}

export function meterTone(fraction: number): 'neutral' | 'warn' | 'danger' {
  if (fraction >= 0.95) return 'danger';
  if (fraction >= 0.8) return 'warn';
  return 'neutral';
}

export const Meter = forwardRef<HTMLSpanElement, MeterProps>(function Meter(
  {
    value,
    max,
    label,
    format = String,
    tone,
    loading = false,
    labelWidth,
    className,
    style,
    ...rest
  },
  ref,
) {
  const measured = value !== null && max > 0 && !loading;
  const fraction = measured ? Math.min(1, Math.max(0, value / max)) : 0;
  const resolvedTone = tone ?? meterTone(fraction);
  return (
    <span
      ref={ref}
      className={cx('ui-meter', `ui-meter--${resolvedTone}`, className)}
      role={measured ? 'meter' : undefined}
      aria-label={measured ? label : undefined}
      aria-valuemin={measured ? 0 : undefined}
      aria-valuemax={measured ? max : undefined}
      aria-valuenow={measured ? value : undefined}
      aria-valuetext={measured ? format(value) : undefined}
      aria-busy={loading || undefined}
      style={labelWidth ? ({ ...style, '--ui-meter-label': labelWidth } as CSSProperties) : style}
      {...rest}
    >
      <span className="ui-meter__label">{label}</span>
      {loading ? (
        <span className="ui-meter__track ui-meter__track--loading" aria-hidden="true" />
      ) : !measured ? (
        <span className="ui-meter__value">Not measured</span>
      ) : (
        <>
          <span className="ui-meter__track" aria-hidden="true">
            <span className="ui-meter__fill" style={{ width: `${Math.round(fraction * 100)}%` }} />
          </span>
          <span className="ui-meter__value">{format(value)}</span>
        </>
      )}
    </span>
  );
});
