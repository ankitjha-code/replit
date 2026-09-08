import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreviewState } from '@platform/shared';
import { createPreviewGrant, fetchPreviewState } from '../../lib/preview-api.js';

/**
 * What a project is serving, if anything.
 *
 * Polled while the project is running but nothing is listening, because that
 * is the state someone is actively working their way out of: they are about to
 * start a server, and the preview should appear when they do rather than when
 * they think to look again.
 */

export interface PreviewControls {
  state: PreviewState | undefined;
  loading: boolean;
  /** A one-time address for the frame. Undefined until asked for. */
  entryUrl: string | undefined;
  /**
   * A separate one-time address for the tab.
   *
   * Separate because each address may be used once, and a tab opened on the
   * one the frame already spent lands on a refusal.
   */
  tabUrl: string | undefined;
  error: string | undefined;
  /** Mints a fresh entry address, which is also how the preview is reloaded. */
  open: () => Promise<void>;
  refresh: () => Promise<void>;
}

const POLL_MS = 3_000;

export function usePreview(projectId: string, running: boolean): PreviewControls {
  const [state, setState] = useState<PreviewState | undefined>();
  const [loading, setLoading] = useState(true);
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

  const refresh = useCallback(async () => {
    try {
      const next = await fetchPreviewState(projectId);
      if (live.current) setState(next);
    } catch {
      // A failed poll is not worth interrupting the workspace for. What is on
      // screen stays, and the next attempt corrects it.
    } finally {
      if (live.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh, running]);

  // A preview that exists for one runtime means nothing for the next one.
  useEffect(() => {
    if (!running) {
      setEntryUrl(undefined);
      setTabUrl(undefined);
    }
  }, [running]);

  const waiting = running && state?.url === null;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => void refresh(), POLL_MS);
    return () => clearTimeout(timer);
  }, [waiting, refresh, state]);

  const open = useCallback(async () => {
    setError(undefined);
    try {
      // Two, because each address may be used once and the frame and the tab
      // are two different browsers as far as the server is concerned.
      const [frame, tab] = await Promise.all([
        createPreviewGrant(projectId),
        createPreviewGrant(projectId),
      ]);
      if (live.current) {
        setEntryUrl(frame);
        setTabUrl(tab);
      }
    } catch {
      if (live.current) setError('The preview could not be opened.');
    }
  }, [projectId]);

  return { state, loading, entryUrl, tabUrl, error, open, refresh };
}
