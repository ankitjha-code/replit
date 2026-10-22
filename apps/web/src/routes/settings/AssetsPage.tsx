import type { ProjectSummary } from '@platform/shared';
import { canWrite } from '../../lib/permissions.js';
import { ProjectAssets } from '../ProjectAssets.js';
import { SettingsSection } from './SettingsSection.js';

export function AssetsPage({ project }: { project: ProjectSummary }): React.JSX.Element {
  return (
    <SettingsSection id="assets">
      <ProjectAssets projectId={project.id} canWrite={canWrite(project.role)} />
    </SettingsSection>
  );
}
