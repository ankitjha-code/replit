import type { ProjectSummary } from '@platform/shared';
import { ProjectLogs } from '../ProjectLogs.js';
import { SettingsSection } from './SettingsSection.js';

/** Output kept after the app stops. Readable by every member. */
export function LogsPage({ project }: { project: ProjectSummary }): React.JSX.Element {
  return (
    <SettingsSection id="logs">
      <ProjectLogs projectId={project.id} />
    </SettingsSection>
  );
}
