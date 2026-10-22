import { useState, type ReactElement } from 'react';
import { participantColour, type PresenceMember } from '@platform/shared';
import type { ProjectSocketStatus } from '../lib/project-socket.js';
import { Avatar, Button, Popover, Tooltip } from '../ui/index.js';
import { CircleNotch, PlugsConnected, WifiSlash } from '../ui/icons.js';

/**
 * Who else has this project open (design spec 9.11).
 *
 * Deliberately quiet. It is a row of initials in the toolbar rather than a
 * panel, because the answer is usually "nobody" and a feature that takes up
 * room when it has nothing to say is a feature that gets switched off.
 *
 * Nothing is shown when the stream is down rather than showing the last roster
 * with a warning on it. A list of people that was true a minute ago is the one
 * genuinely misleading thing this could display.
 */

/** How many faces before the rest fold into "+N". */
const MAX_AVATARS = 4;

export function PresenceBar({
  others,
  connected,
}: {
  others: PresenceMember[];
  connected: boolean;
}): ReactElement | null {
  const [listOpen, setListOpen] = useState(false);
  if (!connected || others.length === 0) return null;

  const shown = others.slice(0, MAX_AVATARS);
  const rest = others.slice(MAX_AVATARS);

  return (
    <div className="presence" role="group" aria-label="Others in this project">
      {shown.map((member) => (
        <Tooltip key={member.userId} content={describe(member)}>
          <span className="presence__member" tabIndex={0}>
            <Avatar
              name={member.displayName}
              userId={member.userId}
              color={participantColour(member.userId)}
              size={24}
            />
            <span className="visually-hidden">{describe(member)}</span>
          </span>
        </Tooltip>
      ))}
      {rest.length > 0 ? (
        <Popover
          open={listOpen}
          onOpenChange={setListOpen}
          title="In this project"
          align="end"
          trigger={
            <Button
              variant="ghost"
              size="sm"
              className="presence__more"
              aria-label={`${rest.length} more people`}
            >
              +{rest.length}
            </Button>
          }
        >
          <ul className="presence__list">
            {others.map((member) => (
              <li key={member.userId} className="presence__row">
                <Avatar
                  name={member.displayName}
                  userId={member.userId}
                  color={participantColour(member.userId)}
                  size={20}
                />
                <span className="presence__row-name">{member.displayName}</span>
                <span className="presence__row-file">{member.file ?? 'No file open'}</span>
              </li>
            ))}
          </ul>
        </Popover>
      ) : null}
    </div>
  );
}

function describe(member: PresenceMember): string {
  const where = member.file ? `, editing ${member.file}` : '';
  const windows = member.connections > 1 ? ` (${member.connections} windows)` : '';
  return `${member.displayName}${where}${windows}`;
}

/**
 * The one fixed spot that says whether the project stream is live. Three
 * states, each with an icon, a word in the tooltip and an accessible name.
 * Reconnecting is never styled as an error: the socket is already retrying.
 */
export function ConnectionStatus({
  status,
  online = true,
}: {
  status: ProjectSocketStatus;
  online?: boolean;
}): ReactElement {
  const view = !online
    ? { icon: WifiSlash, word: 'Offline', tone: 'offline' }
    : status === 'connected'
      ? { icon: PlugsConnected, word: 'Connected', tone: 'connected' }
      : status === 'refused'
        ? { icon: WifiSlash, word: 'Disconnected', tone: 'offline' }
        : { icon: CircleNotch, word: 'Reconnecting…', tone: 'reconnecting' };
  const Icon = view.icon;
  return (
    <Tooltip content={view.word}>
      <span
        className={`connection connection--${view.tone}`}
        role="status"
        aria-label={view.word}
        tabIndex={0}
      >
        <Icon size={16} aria-hidden="true" className="connection__icon" />
      </span>
    </Tooltip>
  );
}
