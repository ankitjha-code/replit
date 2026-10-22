import type { ProjectSummary } from '@platform/shared';
import { canWrite } from '../../lib/permissions.js';
import { ProjectBranches } from '../ProjectBranches.js';
import { SettingsSection } from './SettingsSection.js';

/**
 * Branches and the remote. The section says itself when git is unavailable on
 * the installation, so the page does not read the git state a second time.
 */
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
