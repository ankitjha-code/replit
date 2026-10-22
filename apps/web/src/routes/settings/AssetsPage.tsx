import type { ProjectSummary } from '@platform/shared';
import { canWrite } from '../../lib/permissions.js';
import { ProjectAssets } from '../ProjectAssets.js';
import { SettingsSection } from './SettingsSection.js';

/** Files the code reads that are not source: images, data, downloads. */
export function AssetsPage({ project }: { project: ProjectSummary }): React.JSX.Element {
  return (
    <SettingsSection id="assets">
      <ProjectAssets projectId={project.id} canWrite={canWrite(project.role)} />
    </SettingsSection>
  );
}
