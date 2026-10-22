import { useCallback, useEffect, useId, useRef, useState, type MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import { RUNTIME_DEFINITIONS, type RuntimeStateResponse } from '@platform/shared';
import type * as XtermModule from '@xterm/xterm';
import type { Terminal } from '@xterm/xterm';
import type * as FitModule from '@xterm/addon-fit';
import type { FitAddon } from '@xterm/addon-fit';
import type * as SearchModule from '@xterm/addon-search';
import type { SearchAddon } from '@xterm/addon-search';
import type * as LinksModule from '@xterm/addon-web-links';
import { copyText } from '../../lib/clipboard.js';
import { closeTerminalSession, fetchTerminalSessions } from '../../lib/runtime-api.js';
import { readToken } from '../../theme/read-tokens.js';
import { terminalTheme } from '../../theme/terminal-theme.js';
import { getThemeState, THEME_CHANGE_EVENT } from '../../theme/theme.js';
import {
  Button,
  EmptyState,
  IconButton,
  Input,
  Skeleton,
  Spinner,
  isApplePlatform,
  toast,
} from '../../ui/index.js';
import { CaretDown, CaretUp, Lock, TerminalWindow, Warning, X } from '../../ui/icons.js';
import { useIsPhone } from '../shell/use-phone.js';
import { useWorkspaceActions } from '../shell/workspace-actions.js';
import { TerminalConnection, terminalUrl, type TerminalStatus } from './terminal-connection.js';
import { TerminalKeyRow, withControl } from './TerminalKeyRow.js';
import { MAX_SHELLS, TerminalTabs } from './TerminalTabs.js';
import './terminal.css';

/**
 * The shell: real shells in the project's environment (design spec 9.7).
 *
 * The panel refuses to pretend. With nothing running there is no terminal and
 * it says so, rather than showing an empty rectangle that looks like a shell
 * waiting for input. Every other state it can be in is named too.
 */

export interface TerminalPanelProps {
  projectId: string;
  runtime: RuntimeStateResponse | undefined;
  canAttach: boolean;
  /** For the first line of a fresh shell and the screen's accessible name. */
  projectName?: string | undefined;
  /** Whether the Shell tab is the one on screen; a terminal is focused when it becomes so. */
  active?: boolean;
  /** Bumped to focus the current terminal (Ctrl/Cmd+`). */
  focusRequest?: number;
  /** Bumped to open another shell (Ctrl/Cmd+Shift+`). */
  newRequest?: number;
  /**
   * Where the shells' tab strip goes. The console passes a spot in its own
   * header row, so the strip does not cost the terminal a row of its height;
   * null while that spot is not in the page yet. Left out, the strip sits
   * above the terminal.
   */
  tabsSlot?: HTMLElement | null | undefined;
}

export function TerminalPanel({
  projectId,
  runtime,
  canAttach,
  projectName,
  active = true,
  focusRequest = 0,
  newRequest = 0,
  tabsSlot,
}: TerminalPanelProps): React.JSX.Element {
  const { focusStart } = useWorkspaceActions();
  const hintId = useId();
  const status = runtime?.runtime?.status;

  if (!canAttach) {
    return (
      <EmptyState
        icon={Lock}
        title="No terminal"
        body="You have read-only access to this project, so you cannot run commands in it."
      />
    );
  }

  if (status !== 'RUNNING' || !runtime?.runtime) {
    const starting = status === 'REQUESTED' || status === 'CREATING' || status === 'STARTING';
    return (
      <EmptyState
        icon={TerminalWindow}
        title="Nothing is running"
        body={
          starting
            ? 'The environment is starting. A shell opens here as soon as it is running.'
            : 'Start the environment to open a shell inside it. Commands run in the environment, never on the platform.'
        }
        action={
          starting ? undefined : (
            <>
              <Button variant="link" aria-describedby={hintId} onClick={focusStart}>
                Show me
              </Button>
              <span id={hintId} className="visually-hidden">
                Flashes the Start button in the toolbar
              </span>
            </>
          )
        }
      />
    );
  }

  const definition = RUNTIME_DEFINITIONS[runtime.runtime.language];
  const intro = [projectName, `${definition.displayName} ${runtime.runtime.version}`, '/workspace']
    .filter(Boolean)
    .join(' · ');

  // Keyed on the runtime, so restarting a project gives new terminals rather
  // than reattaching dead sockets to a fresh container.
  return (
    <ShellSessions
      key={runtime.runtime.id}
      projectId={projectId}
      intro={intro}
      label={projectName ? `Shell for ${projectName}` : 'Shell'}
      active={active}
      focusRequest={focusRequest}
      newRequest={newRequest}
      tabsSlot={tabsSlot}
    />
  );
}

interface ShellTab {
  key: string;
  number: number;
  /** The server's session, once known. A tab without one opens a new shell. */
  sessionId: string | undefined;
  lastActiveAt?: string | undefined;
  /** Bumped by "Restart shell", which gives the tab a new terminal. */
  generation: number;
}

/** What a mounted terminal lets the panel do to it. */
interface TerminalHandle {
  focus: () => void;
  send: (data: string) => void;
  clear: () => void;
  find: () => void;
}

let localKeys = 0;
const nextKey = (): string => `shell-${++localKeys}`;

function ShellSessions({
  projectId,
  intro,
  label,
  active,
  focusRequest,
  newRequest,
  tabsSlot,
}: {
  projectId: string;
  intro: string;
  label: string;
  active: boolean;
  focusRequest: number;
  newRequest: number;
  tabsSlot: HTMLElement | null | undefined;
}): React.JSX.Element {
  const phone = useIsPhone();
  const panelPrefix = useId();
  const [tabs, setTabs] = useState<ShellTab[] | undefined>(undefined);
  const [activeKey, setActiveKey] = useState<string | undefined>();
  /** Tabs whose terminal has been shown once; kept mounted from then on. */
  const [visited, setVisited] = useState<ReadonlySet<string>>(new Set());
  const handles = useRef(new Map<string, TerminalHandle>());
  const numbers = useRef(0);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const ctrl = useRef(false);
  ctrl.current = ctrlArmed;

  const tab = (sessionId?: string, lastActiveAt?: string): ShellTab => {
    numbers.current += 1;
    return { key: nextKey(), number: numbers.current, sessionId, lastActiveAt, generation: 0 };
  };

  const select = useCallback((key: string) => {
    setActiveKey(key);
    setVisited((current) => (current.has(key) ? current : new Set(current).add(key)));
  }, []);

  /*
   * Which shells exist, asked of the server.
   *
   * This is what makes a reload come back to the same shells. The browser is
   * not asked what it had open, because a browser that reloaded has forgotten
   * and a browser that remembers may be wrong. If the list cannot be read the
   * panel still opens a shell: a fresh one is a worse outcome than resuming,
   * and a far better one than a panel that refuses to appear.
   */
  const openedFresh = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void fetchTerminalSessions(projectId)
      .catch(() => [])
      .then((sessions) => {
        if (cancelled) return;
        // The server lists newest first; tabs read left to right in the order opened.
        const existing = [...sessions].reverse().map((s) => tab(s.id, s.lastActiveAt));
        openedFresh.current = existing.length === 0;
        const initial = existing.length > 0 ? existing : [tab()];
        const latest = existing.length
          ? [...existing].sort((a, b) =>
              (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''),
            )[0]
          : initial[0];
        setTabs(initial);
        if (latest) select(latest.key);
      });
    return () => {
      cancelled = true;
    };
    // `tab` and `select` are stable in what they do; the list is read once per runtime.
  }, [projectId]);

  const addShell = (): void => {
    if (!tabs || tabs.length >= MAX_SHELLS) return;
    const created = tab();
    setTabs([...tabs, created]);
    select(created.key);
  };
  const addShellRef = useRef(addShell);
  addShellRef.current = addShell;

  // Ctrl/Cmd+Shift+` from the frame, once the list is known.
  const handledNew = useRef(0);
  useEffect(() => {
    if (!tabs || newRequest <= handledNew.current) return;
    handledNew.current = newRequest;
    // A shell opened because none existed already answers the request.
    if (openedFresh.current) {
      openedFresh.current = false;
      return;
    }
    addShellRef.current();
  }, [newRequest, tabs]);

  // Focus follows the panel and the chosen tab, so typing goes where the eye is.
  useEffect(() => {
    if (!active || !activeKey) return;
    handles.current.get(activeKey)?.focus();
  }, [active, activeKey, focusRequest]);

  const closeShell = (key: string): void => {
    if (!tabs) return;
    const index = tabs.findIndex((t) => t.key === key);
    const closing = tabs[index];
    if (!closing) return;
    if (closing.sessionId) {
      void closeTerminalSession(projectId, closing.sessionId).catch(() =>
        toast({ tone: 'danger', title: `Could not close ${shellLabel(closing)}. Try again.` }),
      );
    }
    const remaining = tabs.filter((t) => t.key !== key);
    setTabs(remaining);
    handles.current.delete(key);
    if (activeKey === key) {
      const neighbour = remaining[Math.max(0, index - 1)];
      if (neighbour) select(neighbour.key);
      else setActiveKey(undefined);
    }
  };

  /**
   * Throws this shell away and starts another in the same tab.
   *
   * Needed precisely because closing the panel no longer ends anything. A
   * shell wedged by a process that ignores every key is otherwise something a
   * person cannot get away from by reloading, which used to be the cure.
   */
  const restartShell = (key: string): void => {
    const target = tabs?.find((t) => t.key === key);
    if (!tabs || !target) return;
    if (target.sessionId) {
      // Not awaited: the tab already asks for a new shell. This only stops
      // the abandoned one counting against the project.
      void closeTerminalSession(projectId, target.sessionId).catch(() => undefined);
    }
    setTabs(
      tabs.map((t) =>
        t.key === key ? { ...t, sessionId: undefined, generation: t.generation + 1 } : t,
      ),
    );
  };

  const onSession = useCallback((key: string, sessionId: string) => {
    setTabs((current) =>
      current?.map((t) => (t.key === key && t.sessionId !== sessionId ? { ...t, sessionId } : t)),
    );
  }, []);

  if (!tabs) {
    return (
      <div className="term-panel term-panel--loading" aria-busy="true" aria-label="Opening a shell">
        <Skeleton width="30%" />
        <Skeleton width="55%" />
      </div>
    );
  }

  const panelId = (key: string): string => `${panelPrefix}-${key}`;

  const strip = (
    <TerminalTabs
      tabs={tabs.map((t) => ({ key: t.key, label: shellLabel(t), lastActiveAt: t.lastActiveAt }))}
      activeKey={activeKey}
      panelId={panelId}
      onSelect={select}
      onNew={addShell}
      onClose={closeShell}
      onRestart={restartShell}
      onClear={(key) => handles.current.get(key)?.clear()}
      onFind={(key) => {
        select(key);
        handles.current.get(key)?.find();
      }}
    />
  );

  return (
    <div className={`term-panel${tabs.length === 0 ? ' term-panel--empty' : ''}`}>
      {tabsSlot === undefined ? strip : tabsSlot ? createPortal(strip, tabsSlot) : null}

      {tabs.length === 0 ? (
        <EmptyState
          icon={TerminalWindow}
          title="No shell open."
          action={
            <Button variant="secondary" size="sm" onClick={addShell}>
              New terminal
            </Button>
          }
        />
      ) : null}

      {tabs.map((t) =>
        visited.has(t.key) ? (
          <div
            key={t.key}
            id={panelId(t.key)}
            role="tabpanel"
            aria-label={shellLabel(t)}
            className="term-panel__session"
            hidden={t.key !== activeKey}
          >
            <LiveTerminal
              key={`${t.key}:${t.generation}`}
              projectId={projectId}
              sessionId={t.sessionId}
              intro={intro}
              label={label}
              shown={active && t.key === activeKey}
              ctrl={ctrl}
              onCtrlUsed={() => setCtrlArmed(false)}
              onSession={(id) => onSession(t.key, id)}
              onRestart={() => restartShell(t.key)}
              register={(handle) => {
                if (handle) handles.current.set(t.key, handle);
                else handles.current.delete(t.key);
              }}
            />
          </div>
        ) : null,
      )}

      {phone && activeKey ? (
        <TerminalKeyRow
          ctrlArmed={ctrlArmed}
          onCtrlChange={setCtrlArmed}
          onKey={(data) => handles.current.get(activeKey)?.send(data)}
        />
      ) : null}
    </div>
  );
}

function shellLabel(tab: ShellTab): string {
  return `Shell ${tab.number}`;
}

type XtermModules = [typeof XtermModule, typeof FitModule, typeof SearchModule, typeof LinksModule];

/*
 * xterm and its addons are a few hundred kilobytes, and most visits to a
 * workspace never open a terminal. Loaded when one is, once per page; a failed
 * load is forgotten so Retry really tries again.
 */
let modules: Promise<XtermModules> | undefined;
function loadXterm(): Promise<XtermModules> {
  modules ??= Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-search'),
    import('@xterm/addon-web-links'),
    import('@xterm/xterm/css/xterm.css'),
  ]).then(([xterm, fit, search, links]) => [xterm, fit, search, links] as XtermModules);
  modules.catch(() => {
    modules = undefined;
  });
  return modules;
}

/** Automatic reconnects before the status line asks the person. */
const AUTO_RECONNECTS = 3;
const LOCALHOST_LINK = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i;

function LiveTerminal({
  projectId,
  sessionId,
  intro,
  label,
  shown,
  ctrl,
  onCtrlUsed,
  onSession,
  onRestart,
  register,
}: {
  projectId: string;
  sessionId: string | undefined;
  intro: string;
  label: string;
  shown: boolean;
  ctrl: MutableRefObject<boolean>;
  onCtrlUsed: () => void;
  onSession: (sessionId: string) => void;
  onRestart: () => void;
  register: (handle: TerminalHandle | null) => void;
}): React.JSX.Element {
  const { showPanel } = useWorkspaceActions();
  const host = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const searchRef = useRef<SearchAddon | undefined>(undefined);
  const connection = useRef<TerminalConnection | undefined>(undefined);
  /**
   * The session this view is on.
   *
   * Held in a ref rather than in state because it is not rendered and must not
   * cause the terminal to be rebuilt; a reconnect asks for this one by name,
   * never for whatever the server happens to list first.
   */
  const session = useRef(sessionId);
  const [status, setStatus] = useState<TerminalStatus>({ state: 'connecting' });
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [noteDismissed, setNoteDismissed] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const retries = useRef(0);

  // The latest callbacks, read from inside the long-lived terminal effect.
  const latest = useRef({ shown, onSession, onCtrlUsed, showPanel, intro });
  latest.current = { shown, onSession, onCtrlUsed, showPanel, intro };

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    let terminal: Terminal | undefined;
    let fit: FitAddon | undefined;
    let observer: ResizeObserver | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const onTheme = (): void => {
      if (terminal) terminal.options.theme = terminalTheme(getThemeState().theme);
    };

    void (async () => {
      let loaded: XtermModules;
      try {
        loaded = await loadXterm();
      } catch {
        if (!disposed) setLoadFailed(true);
        return;
      }
      if (disposed) return;
      const [{ Terminal: XTerm }, { FitAddon: Fit }, { SearchAddon: Search }, { WebLinksAddon }] =
        loaded;

      terminal = new XTerm({
        convertEol: false,
        cursorBlink: true,
        fontFamily: readToken('--font-mono') || 'monospace',
        fontSize: 12,
        // Tighter than prose, still looser than most terminals; every row it
        // saves is one more line of output in a short console.
        lineHeight: 1.15,
        // Enough to scroll back through a build, not so much that a runaway
        // process fills the tab's memory.
        scrollback: 5_000,
        screenReaderMode: true,
        theme: terminalTheme(getThemeState().theme),
      });
      terminalRef.current = terminal;
      const term = terminal;

      fit = new Fit();
      const search = new Search();
      searchRef.current = search;
      term.loadAddon(fit);
      term.loadAddon(search);
      term.loadAddon(
        new WebLinksAddon((event, uri) => {
          event.preventDefault();
          // The app's own address means "show me the app", which is the preview.
          if (LOCALHOST_LINK.test(uri)) latest.current.showPanel('preview');
          else window.open(uri, '_blank', 'noopener,noreferrer');
        }),
      );
      term.attachCustomKeyEventHandler((event) => keyHandler(event, term, () => setFindOpen(true)));
      term.open(element);
      term.textarea?.setAttribute('aria-label', label);
      // Deliberately not fitted here. React has not laid the panel out yet, so
      // the element can still have no size, and fitting against that gives the
      // shell a window a few columns wide.
      refit(element, fit);
      document.addEventListener(THEME_CHANGE_EVENT, onTheme);

      const socket = new TerminalConnection(terminalUrl(projectId, session.current), {
        onOutput: (text) => term.write(text),
        onStatus: (next) => {
          if (next.state === 'ready') {
            retries.current = 0;
            setRetrying(false);
            session.current = next.sessionId;
            latest.current.onSession(next.sessionId);
            if (!next.resumed) term.write(`\u001b[2m${latest.current.intro}\u001b[0m\r\n`);
            if (latest.current.shown) term.focus();
          }
          /*
           * A dropped connection is retried a few times before anyone is
           * asked. A refusal is not: it has a reason, and asking again gets
           * the same one.
           */
          if (next.state === 'closed' && retries.current < AUTO_RECONNECTS) {
            const delay = 1_000 * 2 ** retries.current;
            retries.current += 1;
            setRetrying(true);
            retryTimer = setTimeout(() => setAttempt((value) => value + 1), delay);
            return;
          }
          setRetrying(false);
          setStatus(next);
        },
      });
      connection.current = socket;

      term.onData((data) => {
        if (ctrl.current) {
          latest.current.onCtrlUsed();
          socket.send(withControl(data));
          return;
        }
        socket.send(data);
      });
      term.onResize(({ cols, rows }) => socket.resize({ columns: cols, rows }));

      // The panel is resizable, so the terminal has to follow it.
      observer = new ResizeObserver(() => refit(element, fit));
      observer.observe(element);
    })();

    return () => {
      disposed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      observer?.disconnect();
      document.removeEventListener(THEME_CHANGE_EVENT, onTheme);
      /*
       * Close the socket, not the shell.
       *
       * The socket going away detaches; the shell carries on in the
       * container with its scrollback accumulating, and the next mount asks
       * for it by name.
       */
      connection.current?.close();
      connection.current = undefined;
      terminal?.dispose();
      terminalRef.current = undefined;
      searchRef.current = undefined;
    };
  }, [projectId, attempt, ctrl, label]);

  useEffect(() => {
    register({
      focus: () => terminalRef.current?.focus(),
      send: (data) => {
        connection.current?.send(data);
        terminalRef.current?.focus();
      },
      clear: () => terminalRef.current?.clear(),
      find: () => setFindOpen(true),
    });
    return () => register(null);
    // The handle reads refs, so registering once per mount is enough.
  }, []);

  const reconnect = useCallback(() => {
    retries.current = 0;
    setStatus({ state: 'connecting' });
    setNoteDismissed(false);
    setLoadFailed(false);
    setAttempt((value) => value + 1);
  }, []);

  if (loadFailed) {
    return (
      <EmptyState
        icon={Warning}
        title="The terminal could not load"
        body="Its code did not arrive. Check the connection and try again."
        action={
          <Button variant="secondary" size="sm" onClick={reconnect}>
            Retry
          </Button>
        }
      />
    );
  }

  return (
    <div className="term-panel__live">
      {findOpen ? (
        <TerminalFind
          onFind={(query, backwards) =>
            backwards
              ? (searchRef.current?.findPrevious(query) ?? false)
              : (searchRef.current?.findNext(query) ?? false)
          }
          onClose={() => {
            setFindOpen(false);
            searchRef.current?.clearDecorations();
            terminalRef.current?.focus();
          }}
        />
      ) : null}
      <div className="term-panel__screen" ref={host} />
      {retrying ? (
        <div className="term-panel__status" role="status">
          <span className="term-panel__status-text">
            <Spinner size={12} aria-hidden="true" />
            Reconnecting…
          </span>
        </div>
      ) : (
        <TerminalStatusLine
          status={status}
          noteDismissed={noteDismissed}
          onDismissNote={() => setNoteDismissed(true)}
          onReconnect={reconnect}
          onStartFresh={onRestart}
        />
      )}
    </div>
  );
}

/**
 * Keys the terminal hands back to the browser or the workspace.
 *
 * Returning false tells xterm to leave the key alone: copy with a selection,
 * paste (the browser delivers it to xterm's own paste handling), find, and
 * the workspace shortcuts that must work from inside a shell.
 */
function keyHandler(event: KeyboardEvent, terminal: Terminal, openFind: () => void): boolean {
  if (event.type !== 'keydown') return true;
  const mod = isApplePlatform() ? event.metaKey : event.ctrlKey;
  if (!mod) return true;
  const key = event.key.toLowerCase();

  if (key === 'c' && !event.shiftKey && terminal.hasSelection()) {
    event.preventDefault();
    void copyText(terminal.getSelection());
    return false;
  }
  if (key === 'v' && !event.shiftKey) return false;
  if (key === 'f' && !event.shiftKey) {
    event.preventDefault();
    openFind();
    return false;
  }
  if (key === 'enter' || key === '`' || key === 'k' || key === 'p') return false;
  if (key === 'r' && event.shiftKey) return false;
  return true;
}

/** The 28px find row over a terminal (Ctrl/Cmd+F inside it). */
function TerminalFind({
  onFind,
  onClose,
}: {
  onFind: (query: string, backwards: boolean) => boolean;
  onClose: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [missed, setMissed] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);

  const step = (backwards: boolean): void => {
    if (query === '') return;
    setMissed(!onFind(query, backwards));
  };

  return (
    <div className="term-find" role="search">
      <Input
        ref={field}
        size="sm"
        className="term-find__field"
        aria-label="Find in terminal"
        placeholder="Find in terminal"
        value={query}
        invalid={missed}
        onChange={(event) => {
          setQuery(event.target.value);
          setMissed(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            step(event.shiftKey);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <span className="term-find__count" aria-live="polite">
        {missed ? 'No matches' : ''}
      </span>
      <IconButton
        size="sm"
        label="Previous match"
        icon={CaretUp}
        shortcut={['Shift', 'Enter']}
        onClick={() => step(true)}
      />
      <IconButton
        size="sm"
        label="Next match"
        icon={CaretDown}
        shortcut={['Enter']}
        onClick={() => step(false)}
      />
      <IconButton size="sm" label="Close find" icon={X} onClick={onClose} />
    </div>
  );
}

/**
 * Fits the terminal to the panel, once the panel has a size.
 *
 * A zero-sized element is not an error state, it is the moment before layout
 * (or a hidden tab). Fitting against it produces a window a few cells across,
 * and the shell is told that size and wraps everything to it.
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
    // A working shell needs no line unless there is something to know; the
    // tab's menu has "Restart shell" for one that is wedged.
    if (noteDismissed || (!status.resumed && !status.truncated)) return null;
    const note = `${
      status.resumed
        ? 'Reattached to the terminal you already had open.'
        : 'This terminal was already running.'
    }${
      status.truncated
        ? ' Some earlier output was dropped before this, so what is above is not everything it printed.'
        : ''
    }`;

    // Floats over the screen's top corner instead of taking a row: it is
    // something to know, not something wrong, and a row is a lot of a short
    // console.
    return (
      <div className="term-panel__status term-panel__status--note" role="status">
        <span className="term-panel__status-text">{note}</span>
        <Button size="sm" variant="ghost" onClick={onDismissNote}>
          Dismiss
        </Button>
      </div>
    );
  }

  if (status.state === 'connecting') {
    return (
      <div className="term-panel__status" role="status">
        <span className="term-panel__status-text">
          <Spinner size={12} aria-hidden="true" />
          Connecting…
        </span>
      </div>
    );
  }

  const message =
    status.state === 'ended'
      ? `The shell exited${status.code === null ? '' : ` with code ${status.code}`}.`
      : status.state === 'closed'
        ? 'The terminal disconnected.'
        : status.message;

  return (
    <div
      className={`term-panel__status${status.state === 'failed' ? ' term-panel__status--danger' : ''}`}
      role="status"
    >
      <span className="term-panel__status-text">{message}</span>
      <Button size="sm" variant="secondary" onClick={onReconnect}>
        Reconnect
      </Button>
      <Button size="sm" variant="ghost" onClick={onStartFresh}>
        Restart shell
      </Button>
    </div>
  );
}
