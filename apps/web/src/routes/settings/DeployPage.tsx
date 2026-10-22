import { useState } from 'react';
import type { ProjectSummary } from '@platform/shared';
import { ProjectDeployments } from '../ProjectDeployments.js';
import { ProjectDomains } from '../ProjectDomains.js';
import { InPageNav } from './InPageNav.js';
import { OwnerOnlyCallout } from './OwnerOnlyCallout.js';
import { SettingsSection } from './SettingsSection.js';

const SECTIONS = [
  { id: 'deploy-deployments', label: 'Deployments' },
  { id: 'deploy-domains', label: 'Domains' },
];

export function DeployPage({ project }: { project: ProjectSummary }): React.JSX.Element {
  const [addressNonce, setAddressNonce] = useState(0);
  const bump = (): void => setAddressNonce((value) => value + 1);

  if (project.role !== 'OWNER') {
    return <OwnerOnlyCallout projectId={project.id} what="manage deployments" />;
  }

  return (
    <>
      <InPageNav items={SECTIONS} />
      <SettingsSection id="deploy-deployments">
        <ProjectDeployments
          projectId={project.id}
          addressNonce={addressNonce}
          onAddressChanged={bump}
        />
      </SettingsSection>
      <SettingsSection id="deploy-domains">
        <ProjectDomains
          projectId={project.id}
          addressNonce={addressNonce}
          onSubdomainChanged={bump}
        />
      </SettingsSection>
    </>
  );
}
