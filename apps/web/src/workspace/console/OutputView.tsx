import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { parseAnsi, stripAnsi } from '../../lib/ansi.js';
import { Button, Callout, EmptyState, Skeleton, Spinner } from '../../ui/index.js';
import { Cube, Info, Play, TerminalWindow, Warning } from '../../ui/icons.js';
import { appIsLive, shownCommand } from './RunBar.js';
import type { OutputLine, RunControls } from './use-run.js';

export interface OutputMatch {
  line: number;
  start: number;
  end: number;
}

export function findMatches(lines: OutputLine[], query: string): OutputMatch[] {
  const needle = query.toLowerCase();
  if (needle === '') return [];
  const matches: OutputMatch[] = [];
  lines.forEach((line, index) => {
    const haystack = stripAnsi(line.data).toLowerCase();
    let from = haystack.indexOf(needle);
    while (from !== -1) {
      matches.push({ line: index, start: from, end: from + needle.length });
      from = haystack.indexOf(needle, from + needle.length);
    }
  });
  return matches;
}

export interface OutputViewProps {
  run: RunControls;
  runtimeRunning: boolean;
  canControl: boolean;
  wrap: boolean;
  timestamps: boolean;
  matches: OutputMatch[];
  activeMatch: number;
  onShowMe: () => void;
  onSetCommand: () => void;
}

export function OutputView({
  run,
  runtimeRunning,
  canControl,
  wrap,
  timestamps,
  matches,
  activeMatch,
  onShowMe,
  onSetCommand,
}: OutputViewProps): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [behind, setBehind] = useState(false);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (pinned.current) {
      element.scrollTop = element.scrollHeight;
      return;
    }
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distance < 40) pinned.current = true;
    setBehind(distance >= 40);
  }, [run.lines]);

  const onScroll = (): void => {
    const element = scroller.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    pinned.current = distance < 40;
    if (pinned.current) setBehind(false);
  };

  const jump = (): void => {
    const element = scroller.current;
    pinned.current = true;
    setBehind(false);
    if (element) element.scrollTop = element.scrollHeight;
  };

  const current = activeMatch >= 0 ? matches[activeMatch] : undefined;
  useEffect(() => {
    if (!current) return;
    pinned.current = false;
    scroller.current
      ?.querySelector('.output-view__mark--active')
      ?.scrollIntoView({ block: 'center' });
  }, [current]);

  if (run.lines.length === 0 && !run.truncated) {
    return (
      <div className="output-view output-view--empty">
        {run.error ? <SocketError message={run.error} /> : null}
        <Empty
          run={run}
          runtimeRunning={runtimeRunning}
          canControl={canControl}
          onShowMe={onShowMe}
          onSetCommand={onSetCommand}
        />
      </div>
    );
  }

  const byLine = new Map<number, OutputMatch[]>();
  matches.forEach((match) => {
    const list = byLine.get(match.line) ?? [];
    list.push(match);
    byLine.set(match.line, list);
  });

  return (
    <div className="output-view">
      {run.error ? <SocketError message={run.error} /> : null}
      <div
        ref={scroller}
        className={`output-view__log${wrap ? '' : ' output-view__log--nowrap'}`}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Output"
        tabIndex={0}
        onScroll={onScroll}
      >
        {run.truncated ? (
          <SystemLine>
            Earlier output is no longer held. The console keeps what a program printed recently, not
            a full log.
          </SystemLine>
        ) : null}
        {run.lines.map((line, index) => (
          <Chunk
            key={index}
            line={line}
            timestamps={timestamps}
            marks={byLine.get(index)}
            active={current?.line === index ? current : undefined}
          />
        ))}
      </div>
      {behind ? (
        <Button size="sm" variant="secondary" className="output-view__jump" onClick={jump}>
          Jump to latest
        </Button>
      ) : null}
    </div>
  );
}

function Chunk({
  line,
  timestamps,
  marks,
  active,
}: {
  line: OutputLine;
  timestamps: boolean;
  marks: OutputMatch[] | undefined;
  active: OutputMatch | undefined;
}): React.JSX.Element {
  const time = new Date(line.at);
  const stamp = timestamps ? (
    <span className="output-view__time" aria-hidden="true">
      {time.toLocaleTimeString()}
    </span>
  ) : null;

  if (line.stream === 'system') {
    return (
      <SystemLine title={time.toLocaleString()}>
        {stamp}
        {line.data}
      </SystemLine>
    );
  }

  return (
    <span
      className={`output-view__chunk output-view__chunk--${line.stream}`}
      title={time.toLocaleString()}
    >
      {stamp}
      {marks ? (
        <Marked text={stripAnsi(line.data)} marks={marks} active={active} />
      ) : (
        <Ansi text={line.data} />
      )}
    </span>
  );
}

function Ansi({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {parseAnsi(text).map((span, index) =>
        span.classes.length === 0 ? (
          <Fragment key={index}>{span.text}</Fragment>
        ) : (
          <span key={index} className={span.classes.join(' ')}>
            {span.text}
          </span>
        ),
      )}
    </>
  );
}

function Marked({
  text,
  marks,
  active,
}: {
  text: string;
  marks: OutputMatch[];
  active: OutputMatch | undefined;
}): React.JSX.Element {
  const parts: React.ReactNode[] = [];
  let last = 0;
  marks.forEach((mark, index) => {
    parts.push(text.slice(last, mark.start));
    const isActive = active !== undefined && active.start === mark.start;
    parts.push(
      <mark
        key={index}
        className={`output-view__mark${isActive ? ' output-view__mark--active' : ''}`}
      >
        {text.slice(mark.start, mark.end)}
      </mark>,
    );
    last = mark.end;
  });
  parts.push(text.slice(last));
  return <>{parts}</>;
}

function SystemLine({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}): React.JSX.Element {
  return (
    <span className="output-view__system" title={title}>
      <Info size={14} aria-hidden="true" className="output-view__system-icon" />
      <span>{children}</span>
    </span>
  );
}

function SocketError({ message }: { message: string }): React.JSX.Element {
  return (
    <Callout tone="danger" className="output-view__callout">
      {message}
    </Callout>
  );
}

function Empty({
  run,
  runtimeRunning,
  canControl,
  onShowMe,
  onSetCommand,
}: {
  run: RunControls;
  runtimeRunning: boolean;
  canControl: boolean;
  onShowMe: () => void;
  onSetCommand: () => void;
}): React.JSX.Element {
  const hintId = useId();
  const state = run.state;

  if (run.loading) {
    return (
      <div className="output-view__skeleton" aria-busy="true" aria-label="Loading the console">
        <Skeleton width="40%" />
        <Skeleton width="65%" />
        <Skeleton width="30%" />
      </div>
    );
  }

  if (!state && run.loadFailed) {
    return (
      <div className="output-view__center">
        <Callout
          tone="danger"
          title="Could not read the app state."
          action={
            <Button size="sm" variant="secondary" onClick={() => void run.refresh()}>
              Retry
            </Button>
          }
        >
          The console will show the app here once the platform answers.
        </Callout>
      </div>
    );
  }

  if (!runtimeRunning) {
    return (
      <EmptyState
        icon={Cube}
        title={state?.blockedReason ?? 'Start the environment before running the app.'}
        body="Use Start in the toolbar, then Run here."
        action={
          canControl ? (
            <>
              <Button variant="link" aria-describedby={hintId} onClick={onShowMe}>
                Show me
              </Button>
              <span id={hintId} className="visually-hidden">
                Flashes the Start button in the toolbar
              </span>
            </>
          ) : undefined
        }
      />
    );
  }

  const live = appIsLive(state?.status, runtimeRunning);
  if (live) {
    return (
      <div className="output-view__center output-view__waiting">
        <Spinner size={16} aria-hidden="true" />
        <span>
          {state?.status === 'STARTING' ? 'Starting…' : 'Running. Nothing has been printed yet.'}
        </span>
      </div>
    );
  }

  if (state?.status === 'FAILED') {
    return (
      <EmptyState
        icon={Warning}
        title={state.message ?? 'The app failed.'}
        body="Press Run to start it again."
      />
    );
  }

  if (state?.status === 'EXITED') {
    return (
      <EmptyState
        icon={Play}
        title={state.message ?? 'The app is not running.'}
        body="Press Run to start it again."
      />
    );
  }

  const command = shownCommand(run, false);
  if (!command) {
    return (
      <EmptyState
        icon={TerminalWindow}
        title="No run command"
        body="Tell the platform what starts your app."
        action={
          canControl ? (
            <Button variant="secondary" size="sm" onClick={onSetCommand}>
              Set run command
            </Button>
          ) : undefined
        }
      />
    );
  }

  if (state?.blockedReason) {
    return <EmptyState icon={Warning} title={state.blockedReason} />;
  }

  return (
    <EmptyState
      icon={Play}
      title="Nothing has run yet"
      body="Press Run to start the app. What it prints appears here."
    />
  );
}
