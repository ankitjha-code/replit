import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreviewState } from '@platform/shared';
import { createPreviewGrant, fetchPreviewState } from '../../lib/preview-api.js';

/**
 * What a project is serving, if anything.
 *
 * Read only while the environment runs: nothing can be served otherwise, and
 * the panel already knows what to say then. Polled while the environment runs
 * but nothing is listening, because that is the state someone is actively
 * working their way out of: they are about to start a server, and the preview
 * should appear when they do rather than when they think to look again.
 */

export interface PreviewControls {
  state: PreviewState | undefined;
  /** The first read for this run is in flight and nothing is known yet. */
  loading: boolean;
  /** The first read failed, so there is nothing to show but a retry. */
  readFailed: boolean;
  /** A one-time address for the frame. Undefined until asked for. */
  entryUrl: string | undefined;
  /**
   * A separate one-time address for the tab.
   *
   * Separate because each address may be used once, and a tab opened on the
   * one the frame already spent lands on a refusal.
   */
  tabUrl: string | undefined;
  /** Minting the addresses failed. */
  error: string | undefined;
  /** Mints fresh addresses, which is also how the preview is reloaded. */
  open: () => Promise<void>;
  /** Mints a fresh tab address, after the current one was spent. */
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
      // Nothing is listening any more, so the addresses minted for the last
      // server would open a page that is gone. New ones come with the next.
      if (next.url === null) forgetGrants();
    } catch {
      // A failed poll is not worth interrupting the workspace for: what is on
      // screen stays and the next attempt corrects it. Only a first read that
      // fails leaves nothing to show, and that is the one the panel reports.
      if (live.current) setReadFailed(true);
    } finally {
      if (live.current) setLoading(false);
    }
  }, [projectId, forgetGrants]);

  useEffect(() => {
    if (!running) {
      // A preview that exists for one environment means nothing for the next.
      setState(undefined);
      setLoading(false);
      setReadFailed(false);
      forgetGrants();
      return;
    }
    setLoading(true);
    void refresh();
  }, [running, refresh, forgetGrants]);

  /*
   * The app started or stopped. What a project serves goes with it, so the
   * answer from a moment ago is no longer the answer, and a frame still
   * showing the last server's page would be showing something that is gone.
   * The first value is skipped: the effect above already read once.
   */
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
      // Two, because each address may be used once and the frame and the tab
      // are two different browsers as far as the server is concerned. Over
      // plain HTTP there is no frame, so only the tab's is worth minting.
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
      // The next click mints its own address anyway; this one is only for a
      // middle-click or "open in new tab" from the context menu.
      if (live.current) setTabUrl(undefined);
    }
  }, [projectId]);

  return { state, loading, readFailed, entryUrl, tabUrl, error, open, renewTab, refresh };
}
