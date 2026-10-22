import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../../lib/auth-context.js';
import { useDocumentTitle } from '../../lib/use-document-title.js';
import { PageHeader } from '../../ui/index.js';
import { ACCOUNT_SECTIONS, accountPath, type AccountSectionDef } from './pages.js';
import './account.css';

/**
 * Header, sidebar and the section column. The shell owns one route
 * (`account/*`); `AccountPage` owns the inner routes and this layout owns what
 * is around them. Everything here is about this account only, and the header
 * says so once instead of every section repeating it.
 */
export function AccountLayout({
  current,
  children,
}: {
  current: AccountSectionDef;
  children: ReactNode;
}): React.JSX.Element {
  const { user } = useAuth();
  useDocumentTitle([current.label, 'Account']);

  return (
    <div className="account-page">
      <PageHeader
        title="Account"
        description={
          user
            ? `Signed in as ${user.username}. Everything here affects this account only.`
            : 'Everything here affects this account only.'
        }
      />
      <div className="account-page__body">
        <nav aria-label="Account" className="account-nav">
          <ul className="account-nav__list">
            {ACCOUNT_SECTIONS.map((section) => (
              <li key={section.slug}>
                <NavLink
                  to={accountPath(section.slug)}
                  end={section.slug === ''}
                  className="account-nav__link"
                >
                  <section.icon size={16} aria-hidden="true" />
                  <span>{section.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="account-page__content">{children}</div>
      </div>
    </div>
  );
}
