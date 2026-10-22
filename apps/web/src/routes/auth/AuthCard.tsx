import type { ReactElement, ReactNode } from 'react';
import './auth.css';

export interface AuthCardProps {
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  busy?: boolean;
  className?: string;
}

export function AuthCard({
  title,
  description,
  children,
  footer,
  busy,
  className,
}: AuthCardProps): ReactElement {
  return (
    <section
      className={className ? `auth-panel ${className}` : 'auth-panel'}
      {...(busy ? { 'aria-busy': true } : {})}
    >
      {title ? (
        <header className="auth-panel__head">
          <h1 className="auth-panel__title">{title}</h1>
          {description ? <p className="auth-panel__description">{description}</p> : null}
        </header>
      ) : null}
      <div className="auth-panel__body">{children}</div>
      {footer ? <footer className="auth-panel__footer">{footer}</footer> : null}
    </section>
  );
}
