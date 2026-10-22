import type { ReactElement, ReactNode } from 'react';
import './auth.css';

export interface AuthCardProps {
  /** The page's h1. Omitted when the body carries its own heading (an empty state). */
  title?: ReactNode;
  /** One sentence under the title, only where the title does not say enough. */
  description?: ReactNode;
  children?: ReactNode;
  /** The links to the other pages of the flow. */
  footer?: ReactNode;
  /** Set while the card is waiting on the server for its first content. */
  busy?: boolean;
  className?: string;
}

/**
 * The one card every page of the sign-in flow renders in (design spec 10.2).
 * The h1 is the page's heading, exactly as the tests pin it.
 */
export function AuthCard({
  title,
  description,
  children,
  footer,
  busy,
  className,
}: AuthCardProps): ReactElement {
  // Deliberately not a named region: naming it after the h1 would make
  // Playwright's substring `getByLabel('New password')` match the whole card
  // as well as the input, and the heading already says where the user is.
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
