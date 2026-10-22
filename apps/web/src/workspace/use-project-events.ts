import { useEffect, useMemo, useRef, useState } from 'react';
import type { PresenceMember, ProjectEvent } from '@platform/shared';
import {
  ProjectSocket,
  projectEventsUrl,
  type ProjectSocketStatus,
} from '../lib/project-socket.js';
import { useShellBanner } from '../shell/ConnectionBanner.js';

/**
 * The workspace's connection to what is happening in its project.
 *
 * One socket per open workspace, held here and shared by everything that needs
 * it. A hook per panel would mean a socket per panel, and each would carry its
 * own copy of the roster.
 *
 * The handler is kept in a ref rather than being a dependency of the effect, so
 * that a component re-rendering does not tear down and rebuild the connection.
 * A socket that reconnects on every keystroke is worse than no socket.
 */

export interface ProjectPresence {
  /** Everyone in the project, including this window's own account. */
  members: PresenceMember[];
  /** Everyone but this account, which is what a roster usually wants to show. */
  others: PresenceMember[];
  /** False while the stream is down, so the UI can stop claiming to be current. */
  connected: boolean;
  /** What the stream is doing, for the connection indicator. */
  status: ProjectSocketStatus;
  /** Says which file this window is looking at. */
  setFile: (file: string | null) => void;
}

export function useProjectEvents(
  projectId: string,
  onEvent: (event: ProjectEvent) => void,
): ProjectPresence {
  const [members, setMembers] = useState<PresenceMember[]>([]);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<ProjectSocketStatus>('connecting');
  const [selfId, setSelfId] = useState<string | undefined>();
  const { setSocketConnected } = useShellBanner();

  const socket = useRef<ProjectSocket | undefined>(undefined);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    const connection = new ProjectSocket(projectEventsUrl(projectId), {
      onEvent: (event) => handler.current(event),
      onPresence: setMembers,
      onSelf: (self) => setSelfId(self.userId),
      onConnectionChange: setConnected,
      onStatusChange: setStatus,
    });

    socket.current = connection;

    return () => {
      socket.current = undefined;
      connection.close();
    };
  }, [projectId]);

  /*
   * The shell's banner learns about drops, not about the first connection:
   * a slow first handshake is not a lost connection, and a refused socket is
   * the session banner's business rather than a network problem.
   */
  useEffect(() => {
    if (status === 'connected') setSocketConnected(true);
    else if (status === 'reconnecting') setSocketConnected(false);
    else setSocketConnected(null);
  }, [status, setSocketConnected]);

  useEffect(() => () => setSocketConnected(null), [setSocketConnected]);

  const others = useMemo(
    () => members.filter((member) => member.userId !== selfId),
    [members, selfId],
  );

  return useMemo(
    () => ({
      members,
      others,
      connected,
      status,
      setFile: (file: string | null) => socket.current?.setFile(file),
    }),
    [members, others, connected, status],
  );
}
