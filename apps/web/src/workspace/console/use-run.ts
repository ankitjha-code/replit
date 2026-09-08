import { useCallback, useEffect, useRef, useState } from 'react';
import {
  outputMessageSchema,
  outputPath,
  type OutputStream,
  type RunState,
} from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import { fetchRunState, setRunCommand, startRun, stopRun } from '../../lib/runtime-api.js';

/**
 * The project's application, as the console sees it.
 *
 * Two sources, joined here. The state comes from the API, because the server
 * is the only authority on whether a program is running. The output comes from
 * a socket, because it arrives while nobody is asking.
 */

export interface OutputLine {
  stream: OutputStream;
  data: string;
}

export interface RunControls {
  state: RunState | undefined;
  lines: OutputLine[];
  /** True when output older than what is shown was dropped. */
  truncated: boolean;
  loading: boolean;
  busy: boolean;
  error: string | undefined;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** Sets what this project runs, or clears it back to the suggestion. */
  setCommand: (command: string | null) => Promise<void>;
  refresh: () => Promise<void>;
}

/** How many lines the console holds before it forgets the oldest. */
const MAX_LINES = 2_000;

export function useRun(projectId: string, enabled: boolean): RunControls {
  const [state, setState] = useState<RunState | undefined>();
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [truncated, setTruncated] = useState(false);
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
      const next = await fetchRunState(projectId);
      if (live.current) setState(next);
    } catch {
      // A failed read is not worth interrupting the workspace for. What is on
      // screen stays, and the next attempt corrects it.
    } finally {
      if (live.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  /**
   * The output socket.
   *
   * Opened only when there is a runtime to watch. Its history arrives first,
   * so someone who opens the console after a crash sees what caused it.
   */
  useEffect(() => {
    if (!enabled) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}${outputPath(projectId)}`);

    socket.onmessage = (event: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }

      const message = outputMessageSchema.safeParse(parsed);
      // Anything the protocol does not describe is dropped. This text is
      // rendered, and unrecognised text is not safer for having arrived here.
      if (!message.success) return;

      switch (message.data.type) {
        case 'history':
          setLines(message.data.lines.map(({ stream, data }) => ({ stream, data })));
          setTruncated(message.data.truncated);
          return;
        case 'output': {
          const line = { stream: message.data.stream, data: message.data.data };
          setLines((current) => {
            const next = [...current, line];
            // Bounded here as well as on the server: a program printing in a
            // loop should not grow the tab until it dies.
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
          });
          return;
        }
        case 'status':
          // The server says the program changed state. What it changed to
          // comes from the API, which is the authority on all of it.
          void refresh();
          return;
        case 'error':
          setError(message.data.message);
          return;
      }
    };

    return () => socket.close();
  }, [projectId, enabled, refresh]);

  const act = useCallback(
    async (action: () => Promise<RunState>) => {
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

  const start = useCallback(async () => {
    // A fresh run gets a fresh log, matching what the server does.
    setLines([]);
    setTruncated(false);
    await act(() => startRun(projectId));
  }, [act, projectId]);

  const stop = useCallback(() => act(() => stopRun(projectId)), [act, projectId]);

  const setCommand = useCallback(
    (command: string | null) => act(() => setRunCommand(projectId, command)),
    [act, projectId],
  );

  return { state, lines, truncated, loading, busy, error, start, stop, setCommand, refresh };
}
