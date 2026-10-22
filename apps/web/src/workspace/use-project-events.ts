import { useEffect, useMemo, useRef, useState } from 'react';
import type { PresenceMember, ProjectEvent } from '@platform/shared';
import {
  ProjectSocket,
  projectEventsUrl,
  type ProjectSocketStatus,
} from '../lib/project-socket.js';
import { useShellBanner } from '../shell/ConnectionBanner.js';

export interface ProjectPresence {
  members: PresenceMember[];
  others: PresenceMember[];
  connected: boolean;
  status: ProjectSocketStatus;
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
