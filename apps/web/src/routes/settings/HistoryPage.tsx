import type { ProjectSummary } from '@platform/shared';
import { canWrite } from '../../lib/permissions.js';
import { ProjectHistory } from '../ProjectHistory.js';
import { ProjectSnapshots } from '../ProjectSnapshots.js';
import { InPageNav } from './InPageNav.js';
import { SettingsSection } from './SettingsSection.js';

const SECTIONS = [
  { id: 'history-commits', label: 'Commits' },
  { id: 'history-snapshots', label: 'Snapshots' },
];

/** The two ways of writing down what a project was: commits and snapshots. */
export function HistoryPage({ project }: { project: ProjectSummary }): React.JSX.Element {
  const editable = canWrite(project.role);
  return (
    <>
      <InPageNav items={SECTIONS} />
      <SettingsSection id="history-commits">
        <ProjectHistory projectId={project.id} canWrite={editable} />
      </SettingsSection>
      <SettingsSection id="history-snapshots">
        <ProjectSnapshots projectId={project.id} canWrite={editable} />
      </SettingsSection>
    </>
  );
}
