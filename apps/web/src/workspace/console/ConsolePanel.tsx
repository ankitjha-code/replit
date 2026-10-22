import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { RuntimeStateResponse } from '@platform/shared';
import { TabPanel, Tabs, isApplePlatform } from '../../ui/index.js';
import { WORKSPACE_EVENTS } from '../shell/shortcuts.js';
import { useWorkspaceActions, type ConsoleTab } from '../shell/workspace-actions.js';
import { TerminalPanel } from '../terminal/TerminalPanel.js';
import { OutputSearch, OutputToolbar } from './OutputToolbar.js';
import { findMatches, OutputView } from './OutputView.js';
import { appIsLive, RunBar, runBlockedReason } from './RunBar.js';
import { useRun } from './use-run.js';
import './console.css';

/**
 * The console: what the project's application printed, and a shell.
 *
 * Two tabs rather than one surface, because they are two different things. The
 * output is a program the platform started and is watching; the shell is a
 * person typing. Merging them would make it impossible to tell which of the
 * two produced a line, which is exactly the question someone asks when
 * something has gone wrong.
 *
 * Both tabs stay mounted once opened (the inactive one is `hidden`), so
 * switching never reconnects a shell or loses the place in the output.
 */

const TABS = [
  { value: 'output', label: 'Output' },
  { value: 'shell', label: 'Shell' },
];

export function ConsolePanel({
  projectId,
  runtime,
  canControl,
  onRunChange,
  runStateNonce,
  projectName,
  previewListening = false,
}: {
  projectId: string;
  runtime: RuntimeStateResponse | undefined;
  canControl: boolean;
  /** Told when the application starts or stops, so the preview can look again. */
  onRunChange?: (() => void) | undefined;
  /** Bumped when the server says the application changed, so its state is read again. */
  runStateNonce?: number | undefined;
  /** For the shell's first line and accessible name. */
  projectName?: string | undefined;
  /**
   * Something already answers on a port while the app is not running (a
   * server started from the Shell): Run gives the accent to the preview.
   */
  previewListening?: boolean;
}): React.JSX.Element {
  const actions = useWorkspaceActions();
  const [tab, setTab] = useState<ConsoleTab>('output');
  // The shell is not opened until it is asked for: most visits never need one,
  // and opening one starts a process in the environment.
  const [shellOpened, setShellOpened] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [newRequest, setNewRequest] = useState(0);
  const [editing, setEditing] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [timestamps, setTimestamps] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeMatch, setActiveMatch] = useState(0);
  // Where the shells' tabs go: this header row, so they cost no height.
  const [shellTabsSlot, setShellTabsSlot] = useState<HTMLDivElement | null>(null);

  const runtimeRunning = runtime?.runtime?.status === 'RUNNING';
  const detected = runtime?.detected;
  const run = useRun(
    projectId,
    runtimeRunning,
    runStateNonce,
    detected ? `${detected.language}:${detected.evidence}` : '',
  );

  const status = run.state?.status;
  useEffect(() => {
    if (status) onRunChange?.();
  }, [status, onRunChange]);

  const select = (next: ConsoleTab): void => {
    setTab(next);
    if (next === 'shell') setShellOpened(true);
  };
  const selectRef = useRef(select);
  selectRef.current = select;

  // --- the frame's contract (spec 12.1 item 4) ------------------------------

  const { registerConsoleTabSelector, registerRunActions, registerRunTarget } = actions;
  useEffect(() => {
    registerConsoleTabSelector((next) => selectRef.current(next));
    return () => registerConsoleTabSelector(null);
  }, [registerConsoleTabSelector]);

  // The shortcuts call whatever is current, through one stable registration.
  const latest = useRef({ run, canControl, runtimeRunning });
  latest.current = { run, canControl, runtimeRunning };
  useEffect(() => {
    registerRunActions({
      run: () => {
        const { run: now, canControl: may, runtimeRunning: up } = latest.current;
        if (now.busy || appIsLive(now.state?.status, up)) return;
        if (runBlockedReason(now, may, up) !== undefined) return;
        return now.start();
      },
      stop: () => {
        const { run: now, canControl: may, runtimeRunning: up } = latest.current;
        if (!may || now.busy || !appIsLive(now.state?.status, up)) return;
        return now.stop();
      },
      restart: () => {
        const { run: now, canControl: may, runtimeRunning: up } = latest.current;
        if (!may || now.busy || runBlockedReason(now, may, up) !== undefined) return;
        return now.restart();
      },
    });
    return () => registerRunActions(null);
  }, [registerRunActions]);

  // The Run button is handed over as a callback ref below, which React calls
  // with null when the button goes away, so there is nothing to undo here.

  // Ctrl/Cmd+` and Ctrl/Cmd+Shift+` arrive as document events from the frame.
  useEffect(() => {
    const focus = (): void => {
      selectRef.current('shell');
      setFocusRequest((value) => value + 1);
    };
    const create = (): void => {
      selectRef.current('shell');
      setNewRequest((value) => value + 1);
    };
    document.addEventListener(WORKSPACE_EVENTS.focusTerminal, focus);
    document.addEventListener(WORKSPACE_EVENTS.newTerminal, create);
    return () => {
      document.removeEventListener(WORKSPACE_EVENTS.focusTerminal, focus);
      document.removeEventListener(WORKSPACE_EVENTS.newTerminal, create);
    };
  }, []);

  // --- search ----------------------------------------------------------------

  const matches = useMemo(
    () => (searchOpen ? findMatches(run.lines, query) : []),
    [searchOpen, run.lines, query],
  );
  const current = matches.length === 0 ? -1 : Math.min(activeMatch, matches.length - 1);
  const step = (direction: 1 | -1): void => {
    if (matches.length === 0) return;
    setActiveMatch((current + direction + matches.length) % matches.length);
  };

  // Ctrl/Cmd+F while the output has focus searches it, not the page.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || tab !== 'output') return;
    const mod = isApplePlatform() ? event.metaKey : event.ctrlKey;
    if (mod && !event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      setSearchOpen(true);
    }
  };

  return (
    <Tabs
      className="console"
      variant="line"
      label="Console"
      items={TABS}
      value={tab}
      onValueChange={(value) => select(value as ConsoleTab)}
      onKeyDown={onKeyDown}
    >
      <div className="console__header">
        {tab === 'output' ? (
          <OutputToolbar
            projectId={projectId}
            lines={run.lines}
            wrap={wrap}
            onWrapChange={setWrap}
            timestamps={timestamps}
            onTimestampsChange={setTimestamps}
            searchOpen={searchOpen}
            onSearchOpenChange={setSearchOpen}
            onClear={run.clear}
          />
        ) : null}
        <div className="console__shell-tabs" ref={setShellTabsSlot} hidden={tab !== 'shell'} />
        <RunBar
          run={run}
          canControl={canControl}
          runtimeRunning={runtimeRunning}
          editing={editing}
          onEditingChange={setEditing}
          runRef={registerRunTarget}
          compact={tab === 'shell'}
          demoted={previewListening}
        />
      </div>

      <TabPanel
        value="output"
        forceMount
        hidden={tab !== 'output'}
        // The log inside is the stop for Tab; the panel itself need not be one.
        tabIndex={-1}
        className="console__panel"
      >
        {searchOpen ? (
          <OutputSearch
            query={query}
            onQueryChange={(next) => {
              setQuery(next);
              setActiveMatch(0);
            }}
            count={matches.length}
            active={current}
            onStep={step}
            onClose={() => {
              setSearchOpen(false);
              setQuery('');
            }}
          />
        ) : null}
        <OutputView
          run={run}
          runtimeRunning={runtimeRunning}
          canControl={canControl}
          wrap={wrap}
          timestamps={timestamps}
          matches={matches}
          activeMatch={current}
          onShowMe={actions.focusStart}
          onSetCommand={() => setEditing(true)}
        />
      </TabPanel>

      <TabPanel
        value="shell"
        forceMount
        hidden={tab !== 'shell'}
        tabIndex={-1}
        className="console__panel"
      >
        {shellOpened ? (
          <TerminalPanel
            projectId={projectId}
            runtime={runtime}
            canAttach={canControl}
            projectName={projectName}
            active={tab === 'shell'}
            focusRequest={focusRequest}
            newRequest={newRequest}
            tabsSlot={shellTabsSlot}
          />
        ) : null}
      </TabPanel>
    </Tabs>
  );
}
