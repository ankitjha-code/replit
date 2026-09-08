import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuntimeStateResponse } from '@platform/shared';
import { closeTerminalSession, fetchTerminalSessions } from '../../lib/runtime-api.js';
import { PanelPlaceholder } from '../Panel.js';
import { TerminalConnection, terminalUrl, type TerminalStatus } from './terminal-connection.js';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

/**
 * The console: a real shell in the project's runtime.
 *
 * The panel refuses to pretend. With nothing running there is no terminal and
 * it says so, rather than showing an empty black rectangle that looks like a
 * shell waiting for input. Every other state it can be in is named too.
 */

export function TerminalPanel({
  projectId,
  runtime,
  canAttach,
}: {
  projectId: string;
  runtime: RuntimeStateResponse | undefined;
  canAttach: boolean;
}): React.JSX.Element {
  const running = runtime?.runtime?.status === 'RUNNING';

  if (!canAttach) {
    return (
      <PanelPlaceholder
        headline="No terminal"
        detail="You have read-only access to this project, so you cannot run commands in it."
      />
    );
  }

  if (!running) {
    return (
      <PanelPlaceholder
        headline="Nothing is running"
        detail="Start the project to open a terminal in it. Anything you type here runs inside the project's own container, never on the platform."
      />
    );
  }

  // Keyed on the runtime, so restarting a project gives a new terminal rather
  // than reattaching a dead socket to a fresh container.
  return <LiveTerminal key={runtime.runtime?.id} projectId={projectId} />;
}

function LiveTerminal({ projectId }: { projectId: string }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const connection = useRef<TerminalConnection | undefined>(undefined);
  /**
   * The session this view is on.
   *
   * Held in a ref rather than in state because it is not rendered and must not
   * cause the terminal to be rebuilt: remounting is exactly what this feature
   * exists to survive.
   */
  const sessionId = useRef<string | undefined>(undefined);
  /**
   * Set when the next connection must open a shell rather than find one.
   *
   * Asking the server what exists is right on a reload and wrong immediately
   * after asking it to close something: the delete may not have landed yet, so
   * the lookup would hand back the very shell being thrown away. A flag the
   * client sets itself does not depend on two requests arriving in order.
   */
  const forceNew = useRef(false);
  const [status, setStatus] = useState<TerminalStatus>({ state: 'connecting' });
  const [attempt, setAttempt] = useState(0);
  const [noteDismissed, setNoteDismissed] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    let terminal: Terminal | undefined;
    let fit: FitAddon | undefined;
    let observer: ResizeObserver | undefined;
    let disposed = false;

    // xterm and its font are a few hundred kilobytes, and most visits to a
    // workspace never open a terminal. Loaded when one is.
    void (async () => {
      const [{ Terminal: XTerm }, { FitAddon: Fit }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      await import('@xterm/xterm/css/xterm.css');
      if (disposed) return;

      /*
       * Which shell to ask for, decided by the server.
       *
       * This is what makes a reload come back to a running build. The browser
       * is not asked what it had open, because a browser that reloaded has
       * forgotten and a browser that remembers may be wrong. If this fails the
       * terminal still opens: a fresh shell is a worse outcome than resuming,
       * and a far better one than a panel that refuses to appear.
       */
      let resume: string | undefined;
      if (forceNew.current) {
        forceNew.current = false;
      } else {
        try {
          const sessions = await fetchTerminalSessions(projectId);
          resume = sessions[0]?.id;
        } catch {
          resume = undefined;
        }
      }
      if (disposed) return;

      terminal = new XTerm({
        convertEol: false,
        cursorBlink: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 13,
        // Enough to scroll back through a build, not so much that a runaway
        // process fills the tab's memory.
        scrollback: 5_000,
        theme: { background: '#0b0d10', foreground: '#d5d9df', cursor: '#d5d9df' },
      });

      fit = new Fit();
      terminal.loadAddon(fit);
      terminal.open(element);
      // Deliberately not fitted here. React has not laid the panel out yet, so
      // the element can still have no size, and fitting against that gives the
      // shell a window a few columns wide. Everything it prints then wraps at
      // that width and stays wrapped after the real size arrives.
      refit(element, fit);

      const socket = new TerminalConnection(terminalUrl(projectId, resume), {
        onOutput: (text) => terminal?.write(text),
        onStatus: (next) => {
          if (next.state === 'ready') sessionId.current = next.sessionId;
          setStatus(next);
        },
      });
      connection.current = socket;

      terminal.onData((data) => socket.send(data));
      terminal.onResize(({ cols, rows }) => socket.resize({ columns: cols, rows }));

      // The panel is resizable, so the terminal has to follow it. Without
      // this the shell keeps wrapping at the width it started with.
      observer = new ResizeObserver(() => refit(element, fit));
      observer.observe(element);
    })();

    return () => {
      disposed = true;
      observer?.disconnect();
      /*
       * Close the socket, not the shell.
       *
       * This is the change that makes the feature work. The socket going away
       * detaches; the shell carries on in the container with its scrollback
       * accumulating, and the next mount asks for it by name.
       */
      connection.current?.close();
      connection.current = undefined;
      terminal?.dispose();
    };
  }, [projectId, attempt]);

  const reconnect = useCallback(() => {
    setStatus({ state: 'connecting' });
    setNoteDismissed(false);
    setAttempt((value) => value + 1);
  }, []);

  /**
   * Throws this shell away and starts another.
   *
   * Needed precisely because closing the panel no longer ends anything. A
   * shell wedged by a process that ignores every key is otherwise something a
   * person cannot get away from by reloading, which used to be the cure.
   */
  const startFresh = useCallback(() => {
    const current = sessionId.current;
    sessionId.current = undefined;
    forceNew.current = true;
    if (current) {
      // Not awaited, and it does not need to be: the flag above already
      // decides what the next connection asks for. This only stops the
      // abandoned shell counting against the project until it is reaped.
      void closeTerminalSession(projectId, current).catch(() => undefined);
    }
    reconnect();
  }, [projectId, reconnect]);

  return (
    <div className="terminal-panel">
      <div className="terminal-panel__screen" ref={host} />
      <TerminalStatusLine
        status={status}
        noteDismissed={noteDismissed}
        onDismissNote={() => setNoteDismissed(true)}
        onReconnect={reconnect}
        onStartFresh={startFresh}
      />
    </div>
  );
}

/**
 * Fits the terminal to the panel, once the panel has a size.
 *
 * A zero-sized element is not an error state, it is the moment before layout.
 * Fitting against it produces a window a few cells across, and the shell is
 * told that size and wraps everything to it.
 */
function refit(element: HTMLElement, fit: FitAddon | undefined): void {
  if (!fit || element.clientWidth === 0 || element.clientHeight === 0) return;
  try {
    fit.fit();
  } catch {
    // The addon throws while the terminal is being torn down. The next resize
    // corrects it, and there will not be one if it is going away.
  }
}

/**
 * What the connection is doing, and which shell this is.
 *
 * A terminal that has stopped working looks exactly like one waiting for
 * input, so the difference is stated rather than left to be discovered by
 * typing into a dead socket.
 *
 * Two things are said that used to be impossible. That this is the shell you
 * already had, because a prompt with your work still on it should not be
 * indistinguishable from a fresh one. And that the screen above was rebuilt
 * from a window that had already dropped its oldest bytes, because a partial
 * screen presented as a whole one is how someone concludes a command printed
 * nothing.
 */
export function TerminalStatusLine({
  status,
  noteDismissed,
  onDismissNote,
  onReconnect,
  onStartFresh,
}: {
  status: TerminalStatus;
  noteDismissed: boolean;
  onDismissNote: () => void;
  onReconnect: () => void;
  onStartFresh: () => void;
}): React.JSX.Element | null {
  if (status.state === 'ready') {
    /*
     * A live terminal still gets a line, which it did not used to.
     *
     * Now that a shell outlives the window showing it, abandoning one is a
     * thing a person needs to be able to do: a shell wedged by a process that
     * ignores every key used to be cured by reloading, and reloading now
     * reattaches to it. So the control is offered on a working terminal, not
     * only on a broken one, which is exactly where it cannot be reached.
     */
    const note =
      noteDismissed || (!status.resumed && !status.truncated)
        ? undefined
        : `${
            status.resumed
              ? 'Reattached to the terminal you already had open.'
              : 'This terminal was already running.'
          }${
            status.truncated
              ? ' Some earlier output was dropped before this, so what is above is not everything it printed.'
              : ''
          }`;

    return (
      <div className="terminal-panel__status" role="status">
        {note === undefined ? <span /> : <span>{note}</span>}
        {note !== undefined && (
          <button type="button" className="icon-button" onClick={onDismissNote}>
            Dismiss
          </button>
        )}
        <button type="button" className="icon-button" onClick={onStartFresh}>
          New terminal
        </button>
      </div>
    );
  }

  const message =
    status.state === 'connecting'
      ? 'Connecting…'
      : status.state === 'ended'
        ? `The shell exited${status.code === null ? '' : ` with code ${status.code}`}.`
        : status.state === 'closed'
          ? 'The terminal disconnected.'
          : status.message;

  return (
    <div className="terminal-panel__status" role="status">
      <span>{message}</span>
      {status.state !== 'connecting' && (
        <>
          <button type="button" className="icon-button" onClick={onReconnect}>
            Reconnect
          </button>
          <button type="button" className="icon-button" onClick={onStartFresh}>
            New terminal
          </button>
        </>
      )}
    </div>
  );
}
