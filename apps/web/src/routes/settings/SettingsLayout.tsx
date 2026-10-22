import type { ReactNode } from 'react';
import { useMatch } from 'react-router-dom';
import type { ProjectSummary } from '@platform/shared';
import { useDocumentTitle } from '../../lib/use-document-title.js';
import { SettingsHeader } from './SettingsHeader.js';
import { SettingsNav } from './SettingsNav.js';
import { findSettingsPage } from './pages.js';
import './settings.css';

/**
 * Header, sidebar and the page column. The pages render into `children` so
 * the shell owns one route (`settings/*`) and this layout owns what is inside.
 */
export function SettingsLayout({
  projectId,
  project,
  children,
}: {
  projectId: string;
  /** Undefined while the project loads; the layout keeps its shape meanwhile. */
  project: ProjectSummary | undefined;
  children: ReactNode;
}): React.JSX.Element {
  const match = useMatch('/projects/:projectId/settings/:page/*');
  const page = findSettingsPage(match?.params.page);
  useDocumentTitle([page?.label, project?.name]);

  return (
    <div className="settings">
      <SettingsHeader projectId={projectId} project={project} />
      <div className="settings__body">
        <SettingsNav projectId={projectId} role={project?.role} />
        <div className="settings__content" aria-busy={project ? undefined : true}>
          {children}
        </div>
      </div>
    </div>
  );
}
