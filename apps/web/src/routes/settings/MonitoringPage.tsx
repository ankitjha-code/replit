import type { ProjectSummary } from '@platform/shared';
import { canControl } from '../../lib/permissions.js';
import { ProjectAlerts } from '../ProjectAlerts.js';
import { ProjectJobs } from '../ProjectJobs.js';
import { ProjectMonitoring } from '../ProjectMonitoring.js';
import { InPageNav } from './InPageNav.js';
import { SettingsSection } from './SettingsSection.js';

const SECTIONS = [
  { id: 'monitoring-resources', label: 'Resources' },
  { id: 'monitoring-alerts', label: 'Alerts' },
  { id: 'monitoring-activity', label: 'Activity' },
];

export function MonitoringPage({ project }: { project: ProjectSummary }): React.JSX.Element {
  const control = canControl(project.role);
  return (
    <>
      <InPageNav items={SECTIONS} />
      <SettingsSection id="monitoring-resources">
        <ProjectMonitoring projectId={project.id} canControl={control} />
      </SettingsSection>
      <SettingsSection id="monitoring-alerts">
        <ProjectAlerts projectId={project.id} canEdit={project.role === 'OWNER'} />
      </SettingsSection>
      <SettingsSection id="monitoring-activity">
        <ProjectJobs projectId={project.id} canControl={control} />
      </SettingsSection>
    </>
  );
}
