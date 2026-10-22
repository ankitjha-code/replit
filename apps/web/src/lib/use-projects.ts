import { useCallback, useEffect, useState } from 'react';
import type { ProjectSummary } from '@platform/shared';
import { ApiError } from './api-client.js';
import { listProjects } from './projects-api.js';

type State =
  | { status: 'loading' }
  | { status: 'ready'; projects: ProjectSummary[] }
  | { status: 'error'; message: string };

/**
 * The caller's projects.
 *
 * Kept deliberately small: a load, and a way to apply a local change after a
 * create or delete so the list does not have to be refetched to look right.
 * When something more than this is needed, a proper server-state cache earns
 * its place; it does not yet.
 */
export function useProjects(): State & {
  add: (project: ProjectSummary) => void;
  remove: (id: string) => void;
  reload: () => void;
} {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    listProjects(controller.signal)
      .then((projects) => setState({ status: 'ready', projects }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          message: error instanceof ApiError ? error.message : 'Your projects could not be loaded.',
        });
      });

    return () => controller.abort();
  }, [nonce]);

  const add = useCallback((project: ProjectSummary) => {
    setState((current) =>
      current.status === 'ready'
        ? { status: 'ready', projects: [project, ...current.projects] }
        : current,
    );
  }, []);

  const remove = useCallback((id: string) => {
    setState((current) =>
      current.status === 'ready'
        ? { status: 'ready', projects: current.projects.filter((p) => p.id !== id) }
        : current,
    );
  }, []);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { ...state, add, remove, reload };
}
