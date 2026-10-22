import type { ProjectSummary } from '@platform/shared';
import { ProjectDatabase } from '../ProjectDatabase.js';
import { OwnerOnlyCallout } from './OwnerOnlyCallout.js';
import { SettingsSection } from './SettingsSection.js';

/**
 * Owner-only, matching the server: there is nothing useful to show about a
 * database without its connection details, and those are a live credential.
 */
export function DatabasePage({ project }: { project: ProjectSummary }): React.JSX.Element {
  return (
    <SettingsSection id="database">
      {project.role === 'OWNER' ? (
        <ProjectDatabase projectId={project.id} />
      ) : (
        <OwnerOnlyCallout projectId={project.id} what="manage the database" />
      )}
    </SettingsSection>
  );
}
