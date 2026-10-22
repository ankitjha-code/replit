import type { ProjectSummary } from '@platform/shared';
import { ProjectDatabase } from '../ProjectDatabase.js';
import { OwnerOnlyCallout } from './OwnerOnlyCallout.js';
import { SettingsSection } from './SettingsSection.js';

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
