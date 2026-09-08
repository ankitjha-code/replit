import { useCallback, useEffect, useRef, useState } from 'react';
import { isRuntimeTransitional, type RuntimeStateResponse } from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { fetchRuntimeState, startRuntime, stopRuntime } from '../lib/runtime-api.js';

/**
 * The project's runtime, as the workspace sees it.
 *
 * The server is the only authority on what state a runtime is in, so every
 * action here replaces the local state with what came back rather than
 * predicting it. Nothing is ever shown as running because a request was sent.
 */

export interface RuntimeControls {
  state: RuntimeStateResponse | undefined;
  loading: boolean;
  /** A start or stop is in flight. */
  busy: boolean;
  /** The last action's failure, in words from the server. */
  error: string | undefined;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  refresh: () => Promise<void>;
}

/** How often a runtime that is mid-transition is checked again. */
const POLL_MS = 2_000;

export function useRuntime(projectId: string): RuntimeControls {
  const [state, setState] = useState<RuntimeStateResponse | undefined>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchRuntimeState(projectId);
      if (live.current) setState(next);
    } catch {
      // A failed poll is not worth interrupting the workspace for. The state
      // already on screen stays, and the next attempt corrects it.
    } finally {
      if (live.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  /**
   * Runs an action and adopts whatever the server reports afterwards.
   *
   * On failure the state is reloaded rather than left alone, because a failed
   * start leaves a runtime the person needs to see.
   */
  const act = useCallback(
    async (action: () => Promise<RuntimeStateResponse>) => {
      setBusy(true);
      setError(undefined);
      try {
        const next = await action();
        if (live.current) setState(next);
      } catch (cause) {
        if (live.current) {
          setError(
            cause instanceof ApiError ? cause.message : 'The request could not be completed.',
          );
        }
        await refresh();
      } finally {
        if (live.current) setBusy(false);
      }
    },
    [refresh],
  );

  const start = useCallback(() => act(() => startRuntime(projectId)), [act, projectId]);
  const stop = useCallback(() => act(() => stopRuntime(projectId)), [act, projectId]);

  // A runtime someone else is starting changes without this client asking, so
  // a transitional state is checked again until it settles.
  const status = state?.runtime?.status;
  useEffect(() => {
    if (!status || !isRuntimeTransitional(status)) return;
    const timer = setTimeout(() => void refresh(), POLL_MS);
    return () => clearTimeout(timer);
  }, [status, refresh, state]);

  return { state, loading, busy, error, start, stop, refresh };
}
