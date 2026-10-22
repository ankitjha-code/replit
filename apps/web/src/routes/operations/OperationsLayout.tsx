import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useDocumentTitle } from '../../lib/use-document-title.js';
import { Pulse } from '../../ui/icons.js';
import { PageHeader } from '../../ui/index.js';
import { OPERATIONS_SECTIONS, operationsPath, type OperationsSectionDef } from './pages.js';
import './operations.css';

export function OperationsLayout({
  current,
  children,
}: {
  current: OperationsSectionDef;
  children: ReactNode;
}): React.JSX.Element {
  useDocumentTitle([current.slug ? current.label : undefined, 'Operations']);

  return (
    <div className="operations-page">
      <PageHeader
        title="Operations"
        description="This installation as a whole. Nothing here opens a project."
        secondaryActions={[{ id: 'status', label: 'System status', icon: Pulse, to: '/status' }]}
      />
      <div className="operations-page__body">
        <nav aria-label="Operations" className="operations-nav">
          <ul className="operations-nav__list">
            {OPERATIONS_SECTIONS.map((section) => (
              <li key={section.slug}>
                <NavLink
                  to={operationsPath(section.slug)}
                  end={section.slug === ''}
                  className="operations-nav__link"
                >
                  <section.icon size={16} aria-hidden="true" />
                  <span>{section.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="operations-page__content">{children}</div>
      </div>
    </div>
  );
}
