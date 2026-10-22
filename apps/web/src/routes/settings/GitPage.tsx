import type { ProjectSummary } from '@platform/shared';
import { canWrite } from '../../lib/permissions.js';
import { ProjectBranches } from '../ProjectBranches.js';
import { SettingsSection } from './SettingsSection.js';

export function GitPage({ project }: { project: ProjectSummary }): React.JSX.Element {
  return (
    <SettingsSection id="git">
      <ProjectBranches
        projectId={project.id}
        canWrite={canWrite(project.role)}
        canManageRemote={project.role === 'OWNER'}
      />
    </SettingsSection>
  );
}
