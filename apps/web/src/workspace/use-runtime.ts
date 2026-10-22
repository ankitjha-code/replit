import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isRuntimeTransitional,
  type RuntimeLanguage,
  type RuntimeStateResponse,
} from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { fetchRuntimeState, startRuntime, stopRuntime } from '../lib/runtime-api.js';

export interface RuntimeControls {
  state: RuntimeStateResponse | undefined;
  loading: boolean;
  loadError: string | undefined;
  busy: boolean;
  error: string | undefined;
  start: (language?: RuntimeLanguage) => Promise<void>;
  stop: () => Promise<void>;
  refresh: () => Promise<void>;
}

const POLL_MS = 2_000;

function describeFailure(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : 'The request could not be completed.';
}

export function useRuntime(projectId: string): RuntimeControls {
  const [state, setState] = useState<RuntimeStateResponse | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const hasState = useRef(false);
  hasState.current = state !== undefined;

  const refresh = useCallback(async () => {
    try {
      const next = await fetchRuntimeState(projectId);
      if (live.current) {
        setState(next);
        setLoadError(undefined);
      }
    } catch (cause) {
      if (live.current && !hasState.current) setLoadError(describeFailure(cause));
    } finally {
      if (live.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (action: () => Promise<RuntimeStateResponse>) => {
      setBusy(true);
      setError(undefined);
      try {
        const next = await action();
        if (live.current) setState(next);
      } catch (cause) {
        if (live.current) setError(describeFailure(cause));
        await refresh();
      } finally {
        if (live.current) setBusy(false);
      }
    },
    [refresh],
  );

  const start = useCallback(
    (language?: RuntimeLanguage) => act(() => startRuntime(projectId, language)),
    [act, projectId],
  );
  const stop = useCallback(() => act(() => stopRuntime(projectId)), [act, projectId]);

  const status = state?.runtime?.status;
  useEffect(() => {
    if (!status || !isRuntimeTransitional(status)) return;
    const timer = setTimeout(() => void refresh(), POLL_MS);
    return () => clearTimeout(timer);
  }, [status, refresh, state]);

  return { state, loading, loadError, busy, error, start, stop, refresh };
}
