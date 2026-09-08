import type { PresenceMember } from '@platform/shared';

/**
 * Who else has this project open.
 *
 * Deliberately quiet. It is a line in the toolbar rather than a panel, because
 * the answer is usually "nobody" and a feature that takes up room when it has
 * nothing to say is a feature that gets switched off.
 *
 * Nothing is shown when the stream is down rather than showing the last roster
 * with a warning on it. A list of people that was true a minute ago is the one
 * genuinely misleading thing this could display.
 */
export function PresenceBar({
  others,
  connected,
}: {
  others: PresenceMember[];
  connected: boolean;
}): React.JSX.Element | null {
  if (!connected || others.length === 0) return null;

  return (
    <div className="presence" aria-label="Others in this project">
      {others.map((member) => (
        <span
          key={member.userId}
          className="presence__member"
          /* The file is a tooltip rather than text: it is long, it changes
             often, and it is a detail behind the fact that matters, which is
             that somebody else is here. */
          title={describe(member)}
        >
          <span className="presence__initial" aria-hidden="true">
            {initialOf(member.displayName)}
          </span>
          <span className="visually-hidden">{describe(member)}</span>
        </span>
      ))}
    </div>
  );
}

function describe(member: PresenceMember): string {
  const who = `${member.displayName} (@${member.username})`;
  const where = member.file ? ` — ${member.file}` : '';
  const windows = member.connections > 1 ? ` — ${member.connections} windows` : '';
  return `${who}${where}${windows}`;
}

/**
 * The first character of a name, as a letter rather than a picture.
 *
 * No avatars: the platform has never asked anybody for one, and a generated
 * image would be a decoration standing in for information nobody supplied.
 * Taken with the spread operator so a name beginning with an emoji or a
 * non-Latin character is not cut in half.
 */
function initialOf(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? '?';
}
