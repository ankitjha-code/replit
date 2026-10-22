import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { cx } from '../internal/cx.js';
import './Form.css';

export interface FormRowProps extends Omit<ComponentPropsWithoutRef<'div'>, 'children'> {
  label: ReactNode;
  /** The id of the control in `children`, so the label reaches it. */
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}

/** Label on the left in a 160px column at 720px and up, stacked below that. */
export const FormRow = forwardRef<HTMLDivElement, FormRowProps>(function FormRow(
  { label, htmlFor, hint, children, className, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={cx('ui-form-row', className)} {...rest}>
      <div className="ui-form-row__label">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {hint ? <span className="ui-form-row__hint">{hint}</span> : null}
      </div>
      <div className="ui-form-row__control">{children}</div>
    </div>
  );
});

export interface FormGridProps extends ComponentPropsWithoutRef<'div'> {
  columns?: 1 | 2 | 'auto';
  /** Buttons for the form; they sit in their own row and go full width on a phone. */
  actions?: ReactNode;
}

export const FormGrid = forwardRef<HTMLDivElement, FormGridProps>(function FormGrid(
  { columns = 1, actions, children, className, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={cx('ui-form-grid', `ui-form-grid--${columns}`, className)} {...rest}>
      {children}
      {actions ? <div className="ui-form-grid__actions">{actions}</div> : null}
    </div>
  );
});
