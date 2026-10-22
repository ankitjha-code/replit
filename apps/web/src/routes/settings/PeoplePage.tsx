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

/** Who can reach the project, and the time-limited links that let others see it run. */
export function PeoplePage({
  project,
  currentUserId,
  onLeft,
}: {
  project: ProjectSummary;
  currentUserId: string | undefined;
  /** Leaving means the project is no longer yours to look at. */
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
        {/* Showing the running app to people with no account is the same
            decision as deploying it, so the server keeps it with the owner. */}
        {isOwner ? (
          <ProjectPreviewShares projectId={project.id} />
        ) : (
          <OwnerOnlyCallout projectId={project.id} what="make preview links" />
        )}
      </SettingsSection>
    </>
  );
}
