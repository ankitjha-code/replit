import { Link } from 'react-router-dom';
import { listProjectMembers } from '../../lib/projects-api.js';
import { useResource } from '../../lib/use-resource.js';
import { Callout } from '../../ui/index.js';
import { settingsPath } from './pages.js';

export function OwnerOnlyCallout({
  projectId,
  what,
}: {
  projectId: string;
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
