import { Link } from 'react-router-dom';
import { listProjectMembers } from '../../lib/projects-api.js';
import { useResource } from '../../lib/use-resource.js';
import { Callout } from '../../ui/index.js';
import { settingsPath } from './pages.js';

/**
 * What an editor or viewer sees in place of an owner-only section.
 *
 * It names the role that is needed and the person who holds it, so the next
 * step is obvious: ask them. The owner's name comes from the member list,
 * which every member may read.
 */
export function OwnerOnlyCallout({
  projectId,
  what,
}: {
  projectId: string;
  /** Completes "Only the project owner can ...": "manage deployments". */
  what: string;
}): React.JSX.Element {
  const members = useResource((signal) => listProjectMembers(projectId, signal), [projectId]);
  const owner = members.data?.members.find((member) => member.role === 'OWNER');
  const ownerName = owner ? (owner.displayName ?? owner.username) : undefined;

  return (
    <Callout tone="info" title={`Only the project owner can ${what}.`}>
      Ask {ownerName ?? 'the owner'} or see{' '}
      <Link to={settingsPath(projectId, 'people')}>People</Link>.
    </Callout>
  );
}
