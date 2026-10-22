import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreviewState } from '@platform/shared';
import { createPreviewGrant, fetchPreviewState } from '../../lib/preview-api.js';

export interface PreviewControls {
  state: PreviewState | undefined;
  loading: boolean;
  readFailed: boolean;
  entryUrl: string | undefined;
  tabUrl: string | undefined;
  error: string | undefined;
  open: () => Promise<void>;
  renewTab: () => Promise<void>;
  refresh: () => Promise<void>;
}

const POLL_MS = 3_000;

export function usePreview(projectId: string, running: boolean, runNonce = 0): PreviewControls {
  const [state, setState] = useState<PreviewState | undefined>();
  const [loading, setLoading] = useState(running);
  const [readFailed, setReadFailed] = useState(false);
  const [entryUrl, setEntryUrl] = useState<string | undefined>();
  const [tabUrl, setTabUrl] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const forgetGrants = useCallback(() => {
    setEntryUrl(undefined);
    setTabUrl(undefined);
    setError(undefined);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchPreviewState(projectId);
      if (!live.current) return;
      setState(next);
      setReadFailed(false);
      if (next.url === null) forgetGrants();
    } catch {
      if (live.current) setReadFailed(true);
    } finally {
      if (live.current) setLoading(false);
    }
  }, [projectId, forgetGrants]);

  useEffect(() => {
    if (!running) {
      setState(undefined);
      setLoading(false);
      setReadFailed(false);
      forgetGrants();
      return;
    }
    setLoading(true);
    void refresh();
  }, [running, refresh, forgetGrants]);

  const seenNonce = useRef(runNonce);
  useEffect(() => {
    if (seenNonce.current === runNonce) return;
    seenNonce.current = runNonce;
    if (!running) return;
    forgetGrants();
    void refresh();
  }, [runNonce, running, refresh, forgetGrants]);

  const waiting = running && state?.url === null;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => void refresh(), POLL_MS);
    return () => clearTimeout(timer);
  }, [waiting, refresh, state]);

  const framable = state?.framable ?? true;
  const open = useCallback(async () => {
    setError(undefined);
    try {
      const [frame, tab] = await Promise.all([
        framable ? createPreviewGrant(projectId) : Promise.resolve(undefined),
        createPreviewGrant(projectId),
      ]);
      if (live.current) {
        setEntryUrl(frame);
        setTabUrl(tab);
      }
    } catch {
      if (live.current) setError('The preview could not be opened.');
    }
  }, [projectId, framable]);

  const renewTab = useCallback(async () => {
    try {
      const tab = await createPreviewGrant(projectId);
      if (live.current) setTabUrl(tab);
    } catch {
      if (live.current) setTabUrl(undefined);
    }
  }, [projectId]);

  return { state, loading, readFailed, entryUrl, tabUrl, error, open, renewTab, refresh };
}
