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

/**
 * The project's application, as the console sees it.
 *
 * Two sources, joined here. The state comes from the API, because the server
 * is the only authority on whether a program is running. The output comes from
 * a socket, because it arrives while nobody is asking.
 */

/** What printed a line: the program's two streams, or the console itself. */
export type ConsoleStream = OutputStream | 'system';

export interface OutputLine {
  stream: ConsoleStream;
  data: string;
  /** When the line arrived, in epoch milliseconds, for the timestamp column. */
  at: number;
}

/** The output socket, as the header's caption describes it. */
export type OutputConnection = 'idle' | 'connecting' | 'open' | 'reconnecting';

export interface RunControls {
  state: RunState | undefined;
  lines: OutputLine[];
  /** True when output older than what is shown was dropped. */
  truncated: boolean;
  loading: boolean;
  /** The first read failed and nothing is known yet. */
  loadFailed: boolean;
  busy: boolean;
  /** Something the output socket itself reported, shown above the stream. */
  error: string | undefined;
  connection: OutputConnection;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** Stops the program and starts it again with the same command. */
  restart: () => Promise<void>;
  /** Sets what this project runs, or clears it back to the suggestion. Rejects with a message. */
  setCommand: (command: string | null) => Promise<void>;
  /** Forgets what is on screen; the server's copy in Logs is untouched. */
  clear: () => void;
  refresh: () => Promise<void>;
}

/** How many lines the console holds before it forgets the oldest. */
const MAX_LINES = 2_000;
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 15_000;
/** The close code the server uses when access to the project changed. */
const ACCESS_CHANGED = 1008;
const RUN_TOAST_ID = 'console-run-error';

const live = (status: RunStatus | undefined): boolean =>
  status === 'RUNNING' || status === 'STARTING';

export function useRun(
  projectId: string,
  enabled: boolean,
  /** Bumped when the server says the application changed, so it is read again. */
  runStateNonce = 0,
  /**
   * What the platform detected the project to be. The suggested command is
   * read from the same files, so a change here means the suggestion may have
   * changed too, without anything starting or stopping.
   */
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
      // Bounded here as well as on the server: a program printing in a loop
      // should not grow the tab until it dies.
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
      // What is on screen stays, and the next read corrects it. Only a first
      // read that failed is worth saying so, because then nothing is known.
      if (mounted.current) setLoadFailed(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [projectId]);

  /*
   * Read on open, and again whenever the answer may have changed without this
   * client asking. Whether the application may run depends on the container
   * being up, and a run that ends while no output socket is open is announced
   * only through the project's events.
   */
  useEffect(() => {
    void refresh();
  }, [refresh, enabled, runStateNonce, detection]);

  /*
   * System lines for the moments a program ends.
   *
   * Said in the stream, where the person is looking, and in words that say
   * why: a program that exited, one that was stopped, and one whose
   * environment went away are three different things to go and fix.
   */
  /** True while there is a run this console saw start or saw running, whose end is worth a line. */
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

  /**
   * The output socket.
   *
   * Opened only when there is a runtime to watch, and opened again with a
   * growing delay when it drops, because output a person is waiting for
   * should not need a reload to come back. Its history arrives first on every
   * connection, so someone who opens the console after a crash sees what
   * caused it.
   */
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
        // Anything the protocol does not describe is dropped. This text is
        // rendered, and unrecognised text is not safer for having arrived here.
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
            // The server says the program changed state (or, on connect,
            // where it stands). What that means in full comes from the API,
            // which is the authority on all of it.
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
      // The last failure no longer applies once something else is tried.
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
    // A fresh run gets a fresh log, matching what the server does.
    setLines([]);
    setTruncated(false);
    const command = state?.configuredCommand ?? state?.suggestion?.command ?? undefined;
    // A program quick enough to have ended before the answer came back still
    // gets its exit line.
    watching.current = true;
    const ok = await act(() => startRun(projectId));
    if (!ok || !mounted.current) return;
    // First, even if the program printed before the request came back: the
    // log was emptied for this run, so everything in it came after the start.
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
        // The form shows this beside the draft, which it keeps.
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

/** "Exited with code 0 after 12s", from what the server recorded. */
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

/**
 * Closes a socket without the browser's console warning.
 *
 * Closing one that has not finished opening logs "WebSocket is closed before
 * the connection is established" (React's development double-mount does it on
 * every load). Letting it open and then closing it is quiet. `0` is
 * CONNECTING, spelled out so a test's stand-in socket needs no constants.
 */
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
