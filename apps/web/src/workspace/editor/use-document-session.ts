import { useEffect, useRef, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { DocumentParticipant } from '@platform/shared';
import { DocumentConnection, documentUrl } from '../../lib/document-socket.js';

/**
 * One file, shared with everybody else who has it open.
 *
 * The hook is per open editor, and the connection it holds is per path. A
 * session is opened for every text file the editor opens rather than only when
 * a second person turns up: a mode that engages when somebody arrives is a mode
 * that is never exercised until the moment it matters, and this one has to
 * preserve what has been typed while it engages.
 *
 * It fails soft. When the socket is refused or cannot be reached the hook
 * reports `unavailable`, and the editor goes back to loading and saving the
 * file over HTTP exactly as it did before any of this existed. Collaborative
 * editing being unavailable must not mean editing being unavailable.
 */

export type DocumentSessionStatus =
  | { state: 'connecting' }
  /** Live. `canWrite` is the server's answer, never the client's guess. */
  | { state: 'ready'; canWrite: boolean }
  /** The connection dropped and is being retried. What is typed still merges. */
  | { state: 'reconnecting' }
  /**
   * Not available for this file, with the reason.
   *
   * The editor falls back to its own loading and saving. A person is told only
   * that the file is not shared, because the distinction between "refused" and
   * "unreachable" changes nothing they can act on.
   */
  | { state: 'unavailable'; reason: string };

export interface DocumentSessionState {
  status: DocumentSessionStatus;
  /** The shared text, once there is one. Bound to the editor's model. */
  text: Y.Text | undefined;
  /** Where everybody's cursor is, for drawing them. */
  awareness: Awareness | undefined;
  participants: DocumentParticipant[];
  /** When the platform last wrote the file back. */
  savedAt: string | undefined;
  /**
   * Set when the file changed outside this editor.
   *
   * The session stops being written back at that point. Nothing typed is lost,
   * and it is no longer being saved, which is a thing a person has to be told
   * rather than left to discover.
   */
  stale: string | undefined;
}

const IDLE: DocumentSessionState = {
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
  /** False for a file that cannot be shared: binary, too large, or not loaded. */
  enabled: boolean,
): DocumentSessionState {
  const [state, setState] = useState<DocumentSessionState>(IDLE);
  const connection = useRef<DocumentConnection | undefined>(undefined);

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
          // A refusal is final and must not be overwritten by the close that
          // follows it, which would otherwise replace the reason with a retry.
          if (current.status.state === 'unavailable') return current;
          if (connected) return current;

          /*
           * Only a session that was live can be "reconnecting".
           *
           * The editor stands its own saving down while a file is shared, so a
           * session that never became ready and then dropped — a proxy that
           * will not upgrade a WebSocket, a server without the gateway — must
           * not count as shared. If it did, nothing would save at all, which is
           * the opposite of failing soft. Until the document is live, the
           * ordinary save path owns the file.
           */
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
  }, [projectId, path, enabled]);

  return state;
}
