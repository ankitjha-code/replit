import type { ProjectSummary } from '@platform/shared';
import { ProjectMembers } from '../ProjectMembers.js';
import { ProjectPreviewShares } from '../ProjectPreviewShares.js';
import { InPageNav } from './InPageNav.js';
import { OwnerOnlyCallout } from './OwnerOnlyCallout.js';
import { SettingsSection } from './SettingsSection.js';

const SECTIONS = [
  { id: 'people-members', label: 'Members' },
  { id: 'people-links', label: 'Preview links' },
];

export function PeoplePage({
  project,
  currentUserId,
  onLeft,
}: {
  project: ProjectSummary;
  currentUserId: string | undefined;
  onLeft: () => void;
}): React.JSX.Element {
  const isOwner = project.role === 'OWNER';
  return (
    <>
      <InPageNav items={SECTIONS} />
      <SettingsSection id="people-members">
        <ProjectMembers
          projectId={project.id}
          currentUserId={currentUserId}
          canManage={isOwner}
          onLeft={onLeft}
        />
      </SettingsSection>
      <SettingsSection id="people-links">
        {isOwner ? (
          <ProjectPreviewShares projectId={project.id} />
        ) : (
          <OwnerOnlyCallout projectId={project.id} what="make preview links" />
        )}
      </SettingsSection>
    </>
  );
}
