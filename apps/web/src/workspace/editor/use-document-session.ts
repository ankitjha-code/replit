import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { DocumentParticipant } from '@platform/shared';
import { DocumentConnection, documentUrl } from '../../lib/document-socket.js';

export type DocumentSessionStatus =
  | { state: 'connecting' }
  | { state: 'ready'; canWrite: boolean }
  | { state: 'reconnecting' }
  | { state: 'unavailable'; reason: string };

export interface DocumentSessionState {
  status: DocumentSessionStatus;
  text: Y.Text | undefined;
  awareness: Awareness | undefined;
  participants: DocumentParticipant[];
  savedAt: string | undefined;
  stale: string | undefined;
  reconnect: () => void;
}

const IDLE: Omit<DocumentSessionState, 'reconnect'> = {
  status: { state: 'connecting' },
  text: undefined,
  awareness: undefined,
  participants: [],
  savedAt: undefined,
  stale: undefined,
};

export function useDocumentSession(
  projectId: string,
  path: string | undefined,
  enabled: boolean,
): DocumentSessionState {
  const [state, setState] = useState<Omit<DocumentSessionState, 'reconnect'>>(IDLE);
  const connection = useRef<DocumentConnection | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const reconnect = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!path || !enabled) {
      setState(IDLE);
      return;
    }

    setState(IDLE);

    const live = new DocumentConnection(documentUrl(projectId, path), {
      onReady: ({ canWrite, participants }) => {
        setState((current) => ({
          ...current,
          status: { state: 'ready', canWrite },
          participants,
          text: live.text,
          awareness: live.awareness,
        }));
      },
      onParticipants: (participants) => setState((current) => ({ ...current, participants })),
      onSaved: (at) => setState((current) => ({ ...current, savedAt: at })),
      onStale: (message) => setState((current) => ({ ...current, stale: message })),
      onError: ({ message }) =>
        setState((current) => ({ ...current, status: { state: 'unavailable', reason: message } })),
      onConnectionChange: (connected) => {
        setState((current) => {
          if (current.status.state === 'unavailable') return current;
          if (connected) return current;

          if (current.status.state !== 'ready' && current.status.state !== 'reconnecting') {
            return current;
          }

          return { ...current, status: { state: 'reconnecting' }, participants: [] };
        });
      },
    });

    connection.current = live;

    return () => {
      connection.current = undefined;
      live.close();
    };
  }, [projectId, path, enabled, attempt]);

  return useMemo(() => ({ ...state, reconnect }), [state, reconnect]);
}
