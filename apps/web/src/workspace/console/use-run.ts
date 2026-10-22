import { useCallback, useEffect, useRef, useState } from 'react';
import {
  outputMessageSchema,
  outputPath,
  type OutputStream,
  type RunState,
  type RunStatus,
} from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import { fetchRunState, setRunCommand, startRun, stopRun } from '../../lib/runtime-api.js';
import { dismissToast, toast } from '../../ui/index.js';

export type ConsoleStream = OutputStream | 'system';

export interface OutputLine {
  stream: ConsoleStream;
  data: string;
  at: number;
}

export type OutputConnection = 'idle' | 'connecting' | 'open' | 'reconnecting';

export interface RunControls {
  state: RunState | undefined;
  lines: OutputLine[];
  truncated: boolean;
  loading: boolean;
  loadFailed: boolean;
  busy: boolean;
  error: string | undefined;
  connection: OutputConnection;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
  setCommand: (command: string | null) => Promise<void>;
  clear: () => void;
  refresh: () => Promise<void>;
}

const MAX_LINES = 2_000;
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 15_000;
const ACCESS_CHANGED = 1008;
const RUN_TOAST_ID = 'console-run-error';

const live = (status: RunStatus | undefined): boolean =>
  status === 'RUNNING' || status === 'STARTING';

export function useRun(
  projectId: string,
  enabled: boolean,
  runStateNonce = 0,
  detection = '',
): RunControls {
  const [state, setState] = useState<RunState | undefined>();
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [connection, setConnection] = useState<OutputConnection>('idle');

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const append = useCallback((line: Omit<OutputLine, 'at'>) => {
    setLines((current) => {
      const next = [...current, { ...line, at: Date.now() }];
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchRunState(projectId);
      if (!mounted.current) return;
      setState(next);
      setLoadFailed(false);
    } catch {
      if (mounted.current) setLoadFailed(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh, enabled, runStateNonce, detection]);

  const watching = useRef(false);
  const stoppedByYou = useRef(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(() => {
    const now = state?.status;
    if (live(now)) {
      watching.current = true;
      return;
    }
    if (!state || !watching.current || now === undefined) return;
    watching.current = false;

    if (stoppedByYou.current) {
      stoppedByYou.current = false;
      append({ stream: 'system', data: 'Stopped by you' });
      return;
    }
    if (!enabledRef.current) {
      append({ stream: 'system', data: 'Environment stopped' });
      return;
    }
    if (now === 'IDLE') return;
    append({ stream: 'system', data: exitLine(state) });
  }, [state, append]);

  useEffect(() => {
    if (!enabled) {
      setConnection('idle');
      return;
    }

    let disposed = false;
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryMs = FIRST_RETRY_MS;
    let everOpened = false;

    const connect = (): void => {
      setConnection(everOpened ? 'reconnecting' : 'connecting');
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}${outputPath(projectId)}`);
      socket = ws;

      ws.onopen = () => {
        everOpened = true;
        retryMs = FIRST_RETRY_MS;
        setConnection('open');
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }

        const message = outputMessageSchema.safeParse(parsed);
        if (!message.success) return;

        switch (message.data.type) {
          case 'history': {
            const at = Date.now();
            setLines(
              message.data.lines.map(({ stream, data, at: sent }) => ({
                stream,
                data,
                at: Date.parse(sent) || at,
              })),
            );
            setTruncated(message.data.truncated);
            setError(undefined);
            return;
          }
          case 'output':
            append({ stream: message.data.stream, data: message.data.data });
            return;
          case 'status':
            void refresh();
            return;
          case 'error':
            setError(message.data.message);
            return;
        }
      };

      ws.onclose = (event: CloseEvent) => {
        if (disposed || socket !== ws) return;
        socket = undefined;
        if (event.code === ACCESS_CHANGED) {
          setConnection('idle');
          return;
        }
        setConnection('reconnecting');
        timer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      if (socket) closeQuietly(socket);
    };
  }, [projectId, enabled, refresh, append]);

  const toastId = useRef<string | undefined>(undefined);

  const act = useCallback(
    async (action: () => Promise<RunState>): Promise<boolean> => {
      setBusy(true);
      if (toastId.current) dismissToast(toastId.current);
      toastId.current = undefined;
      try {
        const next = await action();
        if (mounted.current) setState(next);
        return true;
      } catch (cause) {
        if (mounted.current) {
          toastId.current = toast({
            id: RUN_TOAST_ID,
            tone: 'danger',
            title:
              cause instanceof ApiError ? cause.message : 'The request could not be completed.',
          });
        }
        await refresh();
        return false;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [refresh],
  );

  const start = useCallback(async () => {
    setLines([]);
    setTruncated(false);
    const command = state?.configuredCommand ?? state?.suggestion?.command ?? undefined;
    watching.current = true;
    const ok = await act(() => startRun(projectId));
    if (!ok || !mounted.current) return;
    const started: OutputLine = {
      stream: 'system',
      data: command ? `Started ${command}` : 'Started',
      at: Date.now(),
    };
    setLines((current) => [started, ...current]);
  }, [act, projectId, state]);

  const stop = useCallback(async () => {
    stoppedByYou.current = true;
    const ok = await act(() => stopRun(projectId));
    if (!ok) stoppedByYou.current = false;
  }, [act, projectId]);

  const restart = useCallback(async () => {
    if (!live(state?.status)) {
      await start();
      return;
    }
    stoppedByYou.current = true;
    const stopped = await act(() => stopRun(projectId));
    if (!stopped) {
      stoppedByYou.current = false;
      return;
    }
    await start();
  }, [act, projectId, start, state?.status]);

  const setCommand = useCallback(
    async (command: string | null) => {
      setBusy(true);
      try {
        const next = await setRunCommand(projectId, command);
        if (mounted.current) setState(next);
      } catch (cause) {
        throw new Error(
          cause instanceof ApiError ? cause.message : 'The run command could not be saved.',
        );
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [projectId],
  );

  const clear = useCallback(() => {
    setTruncated(false);
    setLines([
      { stream: 'system', data: 'Cleared. Earlier output is still in Logs.', at: Date.now() },
    ]);
  }, []);

  return {
    state,
    lines,
    truncated,
    loading,
    loadFailed,
    busy,
    error,
    connection,
    start,
    stop,
    restart,
    setCommand,
    clear,
    refresh,
  };
}

export function exitLine(state: RunState): string {
  const code = state.exitCode;
  const head = code === null ? 'Exited' : `Exited with code ${code}`;
  const started = state.startedAt ? Date.parse(state.startedAt) : NaN;
  const ended = state.exitedAt ? Date.parse(state.exitedAt) : NaN;
  if (Number.isNaN(started) || Number.isNaN(ended) || ended < started) return head;
  return `${head} after ${duration(ended - started)}`;
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function closeQuietly(socket: WebSocket): void {
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
  if (socket.readyState === 0) {
    socket.onopen = () => socket.close();
    return;
  }
  socket.onopen = null;
  socket.close();
}
