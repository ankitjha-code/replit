import { useEffect, useId, useRef, useState } from 'react';
import { MAX_RUN_COMMAND_LENGTH, type RuntimeStateResponse } from '@platform/shared';
import { TerminalPanel } from '../terminal/TerminalPanel.js';
import { useRun, type RunControls } from './use-run.js';

/**
 * The console: what the project's application printed, and a shell.
 *
 * Two tabs rather than one surface, because they are two different things. The
 * output is a program the platform started and is watching; the shell is a
 * person typing. Merging them would make it impossible to tell which of the
 * two produced a line, which is exactly the question someone asks when
 * something has gone wrong.
 */

type Tab = 'output' | 'shell';

export function ConsolePanel({
  projectId,
  runtime,
  canControl,
  onRunChange,
}: {
  projectId: string;
  runtime: RuntimeStateResponse | undefined;
  canControl: boolean;
  /** Told when the application starts or stops, so the preview can look again. */
  onRunChange?: (() => void) | undefined;
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('output');
  const runtimeRunning = runtime?.runtime?.status === 'RUNNING';
  const run = useRun(projectId, runtimeRunning);

  const status = run.state?.status;
  useEffect(() => {
    if (status) onRunChange?.();
  }, [status, onRunChange]);

  return (
    <div className="console-panel">
      <div className="console-panel__tabs" role="tablist" aria-label="Console">
        <ConsoleTab id="output" label="Output" active={tab} onSelect={setTab} />
        <ConsoleTab id="shell" label="Shell" active={tab} onSelect={setTab} />

        {tab === 'output' && (
          <RunControlsBar run={run} canControl={canControl} runtimeRunning={runtimeRunning} />
        )}
      </div>

      <div className="console-panel__body">
        {tab === 'output' ? (
          <OutputView run={run} />
        ) : (
          <TerminalPanel projectId={projectId} runtime={runtime} canAttach={canControl} />
        )}
      </div>
    </div>
  );
}

function ConsoleTab({
  id,
  label,
  active,
  onSelect,
}: {
  id: Tab;
  label: string;
  active: Tab;
  onSelect: (tab: Tab) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active === id}
      className={`console-panel__tab${active === id ? ' console-panel__tab--active' : ''}`}
      onClick={() => onSelect(id)}
    >
      {label}
    </button>
  );
}

/**
 * Starting and stopping the application.
 *
 * Deliberately here rather than in the toolbar beside the runtime's own
 * controls. They are different things, and a single button doing both would
 * hide which one failed when one of them did.
 */
function RunControlsBar({
  run,
  canControl,
  runtimeRunning,
}: {
  run: RunControls;
  canControl: boolean;
  runtimeRunning: boolean;
}): React.JSX.Element {
  const status = run.state?.status ?? 'IDLE';
  const running = status === 'RUNNING' || status === 'STARTING';
  /*
   * What is running, when something is; otherwise what would run.
   *
   * The three are different facts and the order matters. A project that has
   * been told what it runs must not go on showing the platform's guess, and a
   * running program must not be labelled with a command it was not started
   * with.
   */
  const command = running
    ? (run.state?.command ?? run.state?.configuredCommand ?? run.state?.suggestion?.command)
    : (run.state?.configuredCommand ??
      run.state?.suggestion?.command ??
      run.state?.command ??
      undefined);

  const blocked = !canControl
    ? 'You have read-only access to this project.'
    : !runtimeRunning
      ? 'Start the project before running it.'
      : (run.state?.blockedReason ?? undefined);

  return (
    <div className="console-panel__actions">
      <RunCommandField run={run} canControl={canControl} command={command} running={running} />

      <span className="console-panel__status">{statusLabel(status, run.state?.exitCode)}</span>

      <button
        type="button"
        className="icon-button"
        disabled={run.busy || (!running && blocked !== undefined)}
        title={blocked ?? (running ? 'Stop the application' : 'Run the application')}
        onClick={() => void (running ? run.stop() : run.start())}
      >
        {running ? 'Stop' : 'Run'}
      </button>
    </div>
  );
}

/**
 * What this project runs, and a way to change it.
 *
 * The platform's guess is shown when nothing has been set, so a project that
 * can be run says so without anyone configuring it first. A project the guess
 * does not fit needs somewhere to say what it really runs, and this is that
 * place rather than a settings page away from the button it governs.
 */
function RunCommandField({
  run,
  canControl,
  command,
  running,
}: {
  run: RunControls;
  canControl: boolean;
  command: string | undefined;
  running: boolean;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputId = useId();

  if (!editing) {
    return (
      <>
        {command ? (
          <code className="console-panel__command" title={commandTitle(run, running)}>
            {command}
          </code>
        ) : (
          <span className="console-panel__command">No run command</span>
        )}

        {canControl && (
          <button
            type="button"
            className="icon-button"
            // Changing it while something is running would describe the next
            // run, not the one on screen, which reads as though it changed.
            disabled={running || run.busy}
            title={
              running
                ? 'Stop the application before changing what it runs'
                : 'Change what this project runs'
            }
            onClick={() => {
              setDraft(run.state?.configuredCommand ?? '');
              setEditing(true);
            }}
          >
            Edit
          </button>
        )}
      </>
    );
  }

  const close = () => {
    setEditing(false);
    setDraft('');
  };

  return (
    <form
      className="console-panel__command-form"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = draft.trim();
        // Emptied means "go back to the platform's guess", not "run nothing".
        void run.setCommand(trimmed === '' ? null : trimmed).then(close);
      }}
    >
      <label className="visually-hidden" htmlFor={inputId}>
        Run command
      </label>
      <input
        id={inputId}
        className="console-panel__command-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={run.state?.suggestion?.command ?? 'A command to run'}
        maxLength={MAX_RUN_COMMAND_LENGTH}
        autoFocus
        onKeyDown={(event) => {
          if (event.key === 'Escape') close();
        }}
      />
      <button type="submit" className="icon-button" disabled={run.busy}>
        Save
      </button>
      <button type="button" className="icon-button" onClick={close}>
        Cancel
      </button>
    </form>
  );
}

function OutputView({ run }: { run: RunControls }): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  /*
   * Follows new output, unless the person has scrolled away from the bottom.
   *
   * Someone reading an error part-way up should not be dragged back down by a
   * program that is still printing.
   */
  useEffect(() => {
    const element = scroller.current;
    if (!element || !pinned.current) return;
    element.scrollTop = element.scrollHeight;
  }, [run.lines]);

  const onScroll = (): void => {
    const element = scroller.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    pinned.current = distance < 40;
  };

  if (run.loading) {
    return <p className="console-panel__note">Checking…</p>;
  }

  return (
    <div className="console-panel__output" ref={scroller} onScroll={onScroll}>
      {run.error && (
        <p className="console-panel__error" role="alert">
          {run.error}
        </p>
      )}

      {run.truncated && (
        <p className="console-panel__note">
          Earlier output is no longer held. The console keeps what a program printed recently, not a
          full log.
        </p>
      )}

      {run.lines.length === 0 && !run.error && (
        <p className="console-panel__note">{emptyMessage(run)}</p>
      )}

      {run.lines.map((line, index) => (
        <span
          // Output has no identity of its own, and lines repeat. The index is
          // stable because lines are only ever appended or dropped from the
          // front, and a dropped front re-renders the list anyway.
          key={index}
          className={`console-panel__line console-panel__line--${line.stream}`}
        >
          {line.data}
        </span>
      ))}
    </div>
  );
}

/** What to say when there is no output, which is not always the same thing. */
function emptyMessage(run: RunControls): string {
  const state = run.state;
  if (!state) return 'Nothing has run yet.';

  if (state.blockedReason) return state.blockedReason;

  switch (state.status) {
    case 'IDLE':
      return 'Nothing has run yet. Press Run to start the application.';
    case 'STARTING':
      return 'Starting…';
    case 'RUNNING':
      return 'Running. Nothing has been printed yet.';
    case 'EXITED':
      return state.message ?? 'The application is not running.';
    case 'FAILED':
      return state.message ?? 'The application failed.';
  }
}

function statusLabel(status: string, exitCode: number | null | undefined): string {
  switch (status) {
    case 'STARTING':
      return 'Starting…';
    case 'RUNNING':
      return 'Running';
    case 'EXITED':
      return 'Stopped';
    case 'FAILED':
      return exitCode === null || exitCode === undefined ? 'Failed' : `Exited ${exitCode}`;
    default:
      return 'Not running';
  }
}

/** Where the command came from, which a person may want to check. */
function commandTitle(run: RunControls, running: boolean): string {
  const state = run.state;
  if (!state) return '';
  if (running && state.command) return 'The command this run was started with';
  if (state.configuredCommand) return 'Set for this project';
  if (state.suggestion) return `Suggested by the platform, from ${state.suggestion.reason}`;
  return '';
}
