import type { ProjectSummary } from '@platform/shared';
import { canControl, canWrite } from '../../lib/permissions.js';
import { Callout } from '../../ui/index.js';
import { ProjectSecrets } from '../ProjectSecrets.js';
import { ProjectVariables } from '../ProjectVariables.js';
import { HowCodeReadsSection } from '../run/CodeSnippet.js';
import { RunCommandSection } from '../run/RunCommandSection.js';
import { InPageNav } from './InPageNav.js';
import { OwnerOnlyCallout } from './OwnerOnlyCallout.js';
import { SettingsSection } from './SettingsSection.js';

const SECTIONS = [
  { id: 'environment-run', label: 'Run command' },
  { id: 'environment-variables', label: 'Environment variables' },
  { id: 'environment-secrets', label: 'Secrets' },
  { id: 'environment-code', label: 'How your code reads these' },
];

export function EnvironmentPage({ project }: { project: ProjectSummary }): React.JSX.Element {
  const isOwner = project.role === 'OWNER';
  return (
    <>
      <InPageNav items={SECTIONS} />
      <SettingsSection id="environment-run">
        <RunCommandSection projectId={project.id} canControl={canControl(project.role)} />
      </SettingsSection>
      <SettingsSection id="environment-variables">
        {canWrite(project.role) ? (
          <ProjectVariables projectId={project.id} canWrite />
        ) : (
          <Callout tone="info" title="Only editors and the owner can see environment variables.">
            Values here are given to the app when the environment starts.
          </Callout>
        )}
      </SettingsSection>
      <SettingsSection id="environment-secrets">
        {isOwner ? (
          <ProjectSecrets projectId={project.id} />
        ) : (
          <OwnerOnlyCallout projectId={project.id} what="manage secrets" />
        )}
      </SettingsSection>
      <SettingsSection id="environment-code">
        <HowCodeReadsSection projectId={project.id} />
      </SettingsSection>
    </>
  );
}
